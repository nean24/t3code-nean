/**
 * GeminiAdapterLive - Live implementation of the Gemini provider adapter.
 *
 * Manages a per-thread map of `GeminiSessionRuntime` instances, routes
 * adapter operations to the correct runtime, and translates runtime errors
 * into the shared `ProviderAdapterError` algebra.
 *
 * @module GeminiAdapterLive
 */
import { randomUUID } from "node:crypto";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Ref, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  makeGeminiSessionRuntime,
  type GeminiSessionRuntimeError,
  type GeminiSessionRuntimeShape,
} from "./GeminiSessionRuntime.ts";

const PROVIDER = "gemini" as const;

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapRuntimeError(
  threadId: ThreadId,
  method: string,
  error: GeminiSessionRuntimeError,
): ProviderAdapterError {
  if (error._tag === "GeminiSessionRuntimeProcessError") {
    return new ProviderAdapterProcessError({
      provider: PROVIDER,
      threadId,
      detail: error.detail,
      cause: error.cause,
    });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

function notFound(threadId: ThreadId): ProviderAdapterError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

const makeGeminiAdapter = Effect.fn("makeGeminiAdapter")(function* () {
  const serverSettingsService = yield* ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // Per-thread runtime map.
  const sessionsRef = yield* Ref.make<Map<ThreadId, GeminiSessionRuntimeShape>>(new Map());

  // Shared event stream: merge events from all runtime instances.
  // We maintain a list of per-session streams and combine them.
  const sessionEventsRef = yield* Ref.make<ReadonlyArray<Stream.Stream<ProviderRuntimeEvent>>>([]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const getRuntime = (
    threadId: ThreadId,
  ): Effect.Effect<GeminiSessionRuntimeShape, ProviderAdapterError> =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) => {
        const runtime = sessions.get(threadId);
        return runtime ? Effect.succeed(runtime) : Effect.fail(notFound(threadId));
      }),
    );

  const resolveGeminiBinaryPath: Effect.Effect<string> = serverSettingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.gemini.binaryPath),
    Effect.orElseSucceed(() => "gemini"),
  );

  // ── Adapter implementation ────────────────────────────────────────────────

  const adapter: GeminiAdapterShape = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },

    startSession: (input) =>
      Effect.gen(function* () {
        const binaryPath = yield* resolveGeminiBinaryPath;
        const model =
          input.modelSelection?.provider === "gemini"
            ? input.modelSelection.model
            : DEFAULT_MODEL_BY_PROVIDER.gemini;

        const resumeCursor = input.resumeCursor as
          | import("./GeminiSessionRuntime.ts").GeminiResumeCursor
          | undefined;

        const runtimeOptions = {
          threadId: input.threadId,
          binaryPath,
          cwd: input.cwd ?? process.cwd(),
          runtimeMode: input.runtimeMode,
          model,
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        } satisfies import("./GeminiSessionRuntime.ts").GeminiSessionRuntimeOptions;

        const runtime = yield* makeGeminiSessionRuntime(runtimeOptions).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((err) => mapRuntimeError(input.threadId, "startSession", err)),
          Effect.scoped,
        );

        // Register runtime and add its event stream.
        yield* Ref.update(
          sessionsRef,
          (sessions) => new Map([...sessions, [input.threadId, runtime]]),
        );
        yield* Ref.update(sessionEventsRef, (streams) => [...streams, runtime.events]);

        // Start the session and transition to ready.
        const session = yield* runtime
          .start()
          .pipe(Effect.mapError((err) => mapRuntimeError(input.threadId, "startSession", err)));

        return session;
      }),

    sendTurn: (input) =>
      Effect.gen(function* () {
        const runtime = yield* getRuntime(input.threadId);
        const turnId = TurnId.make(randomUUID());
        return yield* runtime
          .sendTurn({
            text: input.input ?? "",
            turnId,
          })
          .pipe(Effect.mapError((err) => mapRuntimeError(input.threadId, "sendTurn", err)));
      }),

    interruptTurn: (threadId) =>
      getRuntime(threadId).pipe(
        Effect.flatMap((runtime) =>
          runtime
            .interruptTurn()
            .pipe(Effect.mapError((err) => mapRuntimeError(threadId, "interruptTurn", err))),
        ),
      ),

    respondToRequest: (threadId, requestId, decision) =>
      getRuntime(threadId).pipe(
        Effect.flatMap((runtime) =>
          runtime
            .respondToRequest(requestId, decision)
            .pipe(Effect.mapError((err) => mapRuntimeError(threadId, "respondToRequest", err))),
        ),
      ),

    respondToUserInput: (threadId, requestId, answers) =>
      getRuntime(threadId).pipe(
        Effect.flatMap((runtime) =>
          runtime
            .respondToUserInput(requestId, answers)
            .pipe(Effect.mapError((err) => mapRuntimeError(threadId, "respondToUserInput", err))),
        ),
      ),

    stopSession: (threadId) =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        const runtime = sessions.get(threadId);
        if (!runtime) return;

        yield* runtime.close.pipe(Effect.ignore);
        yield* Ref.update(sessionsRef, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
      }),

    listSessions: () =>
      Ref.get(sessionsRef).pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(Array.from(sessions.values()), (runtime) => runtime.getSession, {
            concurrency: "unbounded",
          }),
        ),
        Effect.map((sessions): ReadonlyArray<ProviderSession> => sessions),
      ),

    hasSession: (threadId) =>
      Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.has(threadId))),

    readThread: (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "readThread",
          detail: "Gemini provider does not support thread read (no checkpoint storage).",
          cause: undefined,
        }),
      ),

    rollbackThread: (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Gemini provider does not support thread rollback.",
          cause: undefined,
        }),
      ),

    stopAll: () =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef);
        yield* Effect.forEach(
          Array.from(sessions.values()),
          (runtime) => runtime.close.pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        );
        yield* Ref.set(sessionsRef, new Map());
      }),

    get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
      // Return a stream that merges events from all current active sessions.
      // We use a flat-mapped approach: read the current set of streams each
      // time the outer stream is subscribed to and merge them together.
      return Stream.fromEffect(Ref.get(sessionEventsRef)).pipe(
        Stream.flatMap((streams) =>
          streams.length === 0 ? Stream.empty : Stream.mergeAll(streams, { concurrency: 64 }),
        ),
      );
    },
  };

  return adapter;
});

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter());
