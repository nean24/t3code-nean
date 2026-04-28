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
import { Effect, Queue, Ref, Scope, Schema, Stream } from "effect";
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

/**
 * Write a UTF-8 string to a child process stdin via its Effect Sink.
 * The sink type is `Sink<void, Uint8Array, never, never>` as provided by
 * `ChildProcessHandle.stdin`. We use `unknown` to avoid fragile type
 * gymnastics — the Shape interface narrows callers to this module.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const writeToStdin = (stdin: any, text: string): Effect.Effect<void> => {
  const bytes = new TextEncoder().encode(text);
  // Stream.run returns Effect<R,E,A> — we just want void here.
  return (Stream.make(bytes).pipe(Stream.run(stdin)) as Effect.Effect<void, never, never>).pipe(
    Effect.asVoid,
    Effect.ignore,
  );
};

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

    // Build CLI args. We use stream-json output format for structured events.
    const args: string[] = ["--output-format", "stream-json", "--model", model];

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

    // Spawn the long-lived Gemini CLI process.
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

    // ── Stdout consumption ────────────────────────────────────────────────
    // Decode UTF-8 chunks into lines, parse each as a Gemini stream-json event.

    let lineBuffer = "";
    const decoder = new TextDecoder("utf-8");

    const processChunk = (chunk: Uint8Array): ReadonlyArray<ProviderRuntimeEvent> => {
      lineBuffer += decoder.decode(chunk, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      return lines.flatMap((line) => parseGeminiStreamLine(options.threadId, line));
    };

    yield* childHandle.stdout.pipe(
      Stream.mapEffect((chunk) =>
        Effect.forEach(processChunk(chunk), emitEvent, {
          concurrency: 1,
          discard: true,
        }),
      ),
      Stream.runDrain,
      Effect.forkIn(runtimeScope),
    );

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
     * Send a turn by writing the prompt text to the Gemini CLI stdin.
     * The CLI reads one prompt per newline-terminated line.
     */
    const sendTurn = (input: {
      readonly text: string;
      readonly turnId?: TurnId;
    }): Effect.Effect<ProviderTurnStartResult, GeminiSessionRuntimeError> =>
      Effect.gen(function* () {
        const session = yield* Ref.get(sessionRef);
        const turnId = input.turnId ?? TurnId.make(randomUUID());

        // Emit turn.started before writing to CLI.
        yield* emitEvent({
          eventId: makeEventId(),
          provider: PROVIDER,
          threadId: options.threadId,
          createdAt: nowIso(),
          type: "turn.started",
          payload: {},
          turnId,
        });

        // Update session to running.
        yield* Ref.update(sessionRef, (s) => ({
          ...s,
          status: "running" as const,
          activeTurnId: turnId,
          updatedAt: nowIso(),
        }));

        // Write the prompt to stdin.
        yield* writeToStdin(
          childHandle.stdin as Parameters<typeof Stream.run>[1],
          `${input.text}\n`,
        );

        return {
          threadId: options.threadId,
          turnId,
          resumeCursor: session.resumeCursor,
        } satisfies ProviderTurnStartResult;
      });

    /**
     * Interrupt the current turn by sending SIGINT to the Gemini process.
     */
    const interruptTurn = (): Effect.Effect<void, GeminiSessionRuntimeError> =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          try {
            process.kill(childHandle.pid, "SIGINT");
          } catch {
            // Process may already be gone – ignore.
          }
        });

        yield* emitEvent({
          eventId: makeEventId(),
          provider: PROVIDER,
          threadId: options.threadId,
          createdAt: nowIso(),
          type: "turn.aborted",
          payload: { reason: "interrupted" },
        });

        yield* Ref.update(sessionRef, (s) => ({
          ...s,
          status: "ready" as const,
          activeTurnId: undefined,
          updatedAt: nowIso(),
        }));
      });

    /**
     * Respond to an approval request by writing "y\n" or "n\n" to stdin.
     */
    const respondToRequest = (
      _requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ): Effect.Effect<void, GeminiSessionRuntimeError> =>
      writeToStdin(
        childHandle.stdin as Parameters<typeof Stream.run>[1],
        decision === "accept" || decision === "acceptForSession" ? "y\n" : "n\n",
      );

    /**
     * Respond to a user input request by writing the first string answer to stdin.
     */
    const respondToUserInput = (
      _requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, GeminiSessionRuntimeError> => {
      const firstAnswer = Object.values(answers).find((v): v is string => typeof v === "string");
      if (!firstAnswer) return Effect.void;
      return writeToStdin(
        childHandle.stdin as Parameters<typeof Stream.run>[1],
        `${firstAnswer}\n`,
      );
    };

    /**
     * Stop the session by sending SIGTERM to the child process.
     */
    const close: Effect.Effect<void> = Effect.gen(function* () {
      yield* Effect.sync(() => {
        try {
          process.kill(childHandle.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      });

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
