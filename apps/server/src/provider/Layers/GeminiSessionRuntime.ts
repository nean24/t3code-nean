/**
 * GeminiSessionRuntime – Manages one long-lived Gemini CLI session per thread.
 *
 * Spawns `gemini --output-format stream-json` in the thread's project cwd,
 * feeds user messages via a per-turn helper process (piping stdin), and
 * translates the process stdout into canonical `ProviderRuntimeEvent` objects
 * via `GeminiStreamParser`.
 *
 * Design notes:
 * - The Gemini CLI runs as a persistent interactive process.
 * - User turns are written to stdin as a newline-terminated string.
 * - Approval responses are written as "y\n" or "n\n" to stdin.
 * - stdout is read as a stream of newline-delimited JSON objects.
 *
 * @module GeminiSessionRuntime
 */

import { randomUUID } from "node:crypto";

import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Queue, Ref, Scope, Schema, Stream, Deferred } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { parseGeminiStreamLine } from "./GeminiStreamParser.ts";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class GeminiSessionRuntimeProcessError extends Schema.TaggedErrorClass<GeminiSessionRuntimeProcessError>()(
  "GeminiSessionRuntimeProcessError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Gemini session process error: ${this.detail}`;
  }
}

export class GeminiSessionRuntimeNotActiveError extends Schema.TaggedErrorClass<GeminiSessionRuntimeNotActiveError>()(
  "GeminiSessionRuntimeNotActiveError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Gemini session is not active for thread: ${this.threadId}`;
  }
}

export type GeminiSessionRuntimeError =
  | GeminiSessionRuntimeProcessError
  | GeminiSessionRuntimeNotActiveError;

// ---------------------------------------------------------------------------
// Resume cursor
// ---------------------------------------------------------------------------

export const GeminiResumeCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.optional(Schema.String),
});
export type GeminiResumeCursor = typeof GeminiResumeCursorSchema.Type;

export function readGeminiResumeCursor(
  resumeCursor: ProviderSession["resumeCursor"],
): GeminiResumeCursor | undefined {
  return Schema.is(GeminiResumeCursorSchema)(resumeCursor) ? resumeCursor : undefined;
}

// ---------------------------------------------------------------------------
// Options / Shape
// ---------------------------------------------------------------------------

export interface GeminiSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly resumeCursor?: GeminiResumeCursor;
}

export interface GeminiSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, GeminiSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (input: {
    readonly text: string;
    readonly turnId?: TurnId;
  }) => Effect.Effect<ProviderTurnStartResult, GeminiSessionRuntimeError>;
  readonly interruptTurn: () => Effect.Effect<void, GeminiSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, GeminiSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, GeminiSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderRuntimeEvent>;
  readonly close: Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const PROVIDER = "gemini" as const;

function resolveModel(model: string | undefined): string {
  return model?.trim() || DEFAULT_MODEL_BY_PROVIDER.gemini;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): EventId {
  return EventId.make(randomUUID());
}

export const makeGeminiSessionRuntime = (
  options: GeminiSessionRuntimeOptions,
): Effect.Effect<
  GeminiSessionRuntimeShape,
  GeminiSessionRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventsQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const model = resolveModel(options.model);

    const initialSession: ProviderSession = {
      provider: PROVIDER,
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      model,
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeChildRef = yield* Ref.make<any>(undefined);
    const closedRef = yield* Ref.make(false);

    // ── Emit helpers ──────────────────────────────────────────────────────

    const emitEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(eventsQueue, event).pipe(Effect.asVoid);

    const emitSessionStateChanged = (
      state: "starting" | "ready" | "stopped",
    ): Effect.Effect<void> =>
      emitEvent({
        eventId: makeEventId(),
        provider: PROVIDER,
        threadId: options.threadId,
        createdAt: nowIso(),
        type: "session.state.changed",
        payload: { state },
      });

    // ── Session lifecycle ────────────────────────────────────────────────

    const start = (): Effect.Effect<ProviderSession, GeminiSessionRuntimeError> =>
      Effect.gen(function* () {
        yield* emitSessionStateChanged("starting");
        const session: ProviderSession = {
          ...(yield* Ref.get(sessionRef)),
          status: "ready",
          updatedAt: nowIso(),
        };
        yield* Ref.set(sessionRef, session);
        yield* emitSessionStateChanged("ready");
        return session;
      });

    const getSession: Effect.Effect<ProviderSession> = Ref.get(sessionRef);

    /**
     * Send a turn by spawning a new Gemini CLI process with the prompt.
     */
    const sendTurn = (input: {
      readonly text: string;
      readonly turnId?: TurnId;
    }): Effect.Effect<ProviderTurnStartResult, GeminiSessionRuntimeError> =>
      Effect.gen(function* () {
        const session = yield* Ref.get(sessionRef);
        const turnId = input.turnId ?? TurnId.make(randomUUID());

        // Emit turn.started locally.
        yield* emitEvent({
          eventId: makeEventId(),
          provider: PROVIDER,
          threadId: options.threadId,
          createdAt: nowIso(),
          type: "turn.started",
          payload: {},
          turnId,
        });

        yield* Ref.update(sessionRef, (s) => ({
          ...s,
          status: "running" as const,
          activeTurnId: turnId,
          updatedAt: nowIso(),
        }));

        const args: string[] = [
          "-p",
          '""',
          "--output-format",
          "stream-json",
          "--skip-trust",
          "--approval-mode",
          "auto_edit",
          "--model",
          model,
        ];

        // Only pass resume if we already have a Gemini session ID
        const currentCursor = readGeminiResumeCursor(session.resumeCursor);
        if (currentCursor?.sessionId) {
          args.push("--resume", currentCursor.sessionId);
        }

        const childHandle = yield* spawner
          .spawn(
            ChildProcess.make(options.binaryPath, args, {
              cwd: options.cwd,
              shell: process.platform === "win32",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
            Effect.mapError(
              (cause) =>
                new GeminiSessionRuntimeProcessError({
                  detail: `Failed to spawn Gemini CLI: ${cause instanceof Error ? cause.message : String(cause)}`,
                  cause,
                }),
            ),
          );

        yield* Ref.set(activeChildRef, childHandle);

        yield* Stream.make(new TextEncoder().encode(`${input.text}\n`))
          .pipe(Stream.run(childHandle.stdin as Parameters<typeof Stream.run>[1]))
          .pipe(Effect.forkIn(runtimeScope));

        let stdoutBuffer = "";

        const initDeferred = yield* Deferred.make<string, never>();

        // Consume stdout
        yield* childHandle.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => {
            stdoutBuffer += chunk;
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            return Effect.forEach(
              lines,
              (line) => {
                if (line.trim()) {
                  try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === "init" && parsed.session_id) {
                      return Effect.flatMap(
                        Deferred.succeed(initDeferred, parsed.session_id),
                        () => Effect.forEach(parseGeminiStreamLine(options.threadId, turnId, line), emitEvent, { discard: true })
                      );
                    }
                  } catch {
                    // ignore JSON parse error here
                  }
                }
                return Effect.forEach(
                  parseGeminiStreamLine(options.threadId, turnId, line),
                  emitEvent,
                  { concurrency: 1, discard: true }
                );
              },
              { concurrency: 1, discard: true }
            );
          }),
          Effect.forkIn(runtimeScope),
        );

        // Consume stderr
        yield* childHandle.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => {
            const line = chunk.trim();
            if (!line) return Effect.void;
            // Ignore color warnings
            if (line.includes("256-color support not detected")) return Effect.void;
            return emitEvent({
              eventId: makeEventId(),
              provider: PROVIDER,
              threadId: options.threadId,
              createdAt: nowIso(),
              type: "runtime.error",
              payload: { message: line, class: "provider_error" },
            });
          }),
          Effect.forkIn(runtimeScope),
        );

        // Track process exit to end the turn
        yield* childHandle.exitCode.pipe(
          Effect.flatMap((exitCode) =>
            Effect.gen(function* () {
              // Unblock sendTurn if the process exited before emitting init
              yield* Deferred.succeed(initDeferred, "");

              yield* Ref.set(activeChildRef, undefined);
              const closed = yield* Ref.get(closedRef);
              if (closed) return;

              const isError = exitCode !== 0;
              yield* Ref.update(sessionRef, (s) => ({
                ...s,
                status: "ready" as const,
                activeTurnId: undefined,
                updatedAt: nowIso(),
              }));

              yield* emitEvent({
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId: options.threadId,
                createdAt: nowIso(),
                turnId,
                type: "turn.completed",
                payload: {
                  state: isError ? "failed" : "completed",
                  ...(isError ? { errorMessage: `Gemini CLI process exited with code ${exitCode}` } : {})
                },
              });
            }),
          ),
          Effect.forkIn(runtimeScope),
        );

        const newSessionId = yield* Deferred.await(initDeferred);

        if (newSessionId) {
          yield* Ref.update(sessionRef, (s) => ({
            ...s,
            resumeCursor: { version: 1, sessionId: newSessionId }
          }));
        }

        const finalSession = yield* Ref.get(sessionRef);

        return {
          threadId: options.threadId,
          turnId,
          resumeCursor: finalSession.resumeCursor,
        } satisfies ProviderTurnStartResult;
      });

    /**
     * Interrupt the current turn by killing the active process.
     */
    const interruptTurn = (): Effect.Effect<void, GeminiSessionRuntimeError> =>
      Effect.gen(function* () {
        const childHandle = yield* Ref.get(activeChildRef);
        if (childHandle) {
          yield* Effect.sync(() => {
            try {
              process.kill(childHandle.pid, "SIGINT");
            } catch {
              // ignore
            }
          });
        }
      });

    const respondToRequest = (
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, GeminiSessionRuntimeError> => Effect.void;

    const respondToUserInput = (
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, GeminiSessionRuntimeError> => Effect.void;

    const close: Effect.Effect<void> = Effect.gen(function* () {
      yield* Ref.set(closedRef, true);
      const childHandle = yield* Ref.get(activeChildRef);
      if (childHandle) {
        yield* Effect.sync(() => {
          try {
            process.kill(childHandle.pid, "SIGTERM");
          } catch {
            // ignore
          }
        });
      }

      yield* Ref.update(sessionRef, (s) => ({
        ...s,
        status: "closed" as const,
        updatedAt: nowIso(),
      }));

      yield* emitEvent({
        eventId: makeEventId(),
        provider: PROVIDER,
        threadId: options.threadId,
        createdAt: nowIso(),
        type: "session.exited",
        payload: { exitKind: "graceful" as const },
      });

      yield* Queue.shutdown(eventsQueue);
    });

    return {
      start,
      getSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      events: Stream.fromQueue(eventsQueue),
      close,
    } satisfies GeminiSessionRuntimeShape;
  });
