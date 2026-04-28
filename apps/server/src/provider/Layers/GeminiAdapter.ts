/**
 * GeminiAdapterLive - Scoped live implementation for the Gemini CLI provider adapter.
 *
 * Spawns and manages Gemini CLI sessions, parses stream-json output into
 * canonical ProviderRuntimeEvents, and forwards approval requests to the
 * shared orchestration layer.
 *
 * NOTE: Full runtime implementation is in progress. Session operations are
 * stubbed and will be replaced with the live Gemini CLI integration.
 *
 * @module GeminiAdapterLive
 */
import { Effect, Layer, PubSub, Stream } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import { ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";

const makeGeminiAdapter = Effect.fn("makeGeminiAdapter")(function* () {
  const eventsPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );

  const adapter: GeminiAdapterShape = {
    provider: "gemini",
    capabilities: { sessionModelSwitch: "unsupported" },

    startSession: (input) =>
      Effect.die(
        new Error(`GeminiAdapter.startSession not yet implemented for thread ${input.threadId}`),
      ),

    sendTurn: (input) =>
      Effect.die(
        new Error(`GeminiAdapter.sendTurn not yet implemented for thread ${input.threadId}`),
      ),

    interruptTurn: (threadId) =>
      Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: "gemini" as const,
          threadId,
        }) as unknown as ProviderAdapterError,
      ),

    respondToRequest: (_threadId, _requestId, _decision) => Effect.void,

    respondToUserInput: (_threadId, _requestId, _answers) => Effect.void,

    stopSession: (threadId) =>
      Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: "gemini" as const,
          threadId,
        }) as unknown as ProviderAdapterError,
      ),

    listSessions: () => Effect.succeed([]),

    hasSession: (_threadId) => Effect.succeed(false),

    readThread: (threadId) =>
      Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: "gemini" as const,
          threadId,
        }) as unknown as ProviderAdapterError,
      ),

    rollbackThread: (threadId) =>
      Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: "gemini" as const,
          threadId,
        }) as unknown as ProviderAdapterError,
      ),

    stopAll: () => Effect.void,

    streamEvents: Stream.fromPubSub(eventsPubSub),
  };

  return adapter;
});

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter());
