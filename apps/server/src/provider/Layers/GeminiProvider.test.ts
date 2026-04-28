/**
 * GeminiProviderLive tests – verifies probe status, model catalog,
 * and settings-change reactivity.
 */
import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GeminiProvider } from "../Services/GeminiProvider.ts";
import { GeminiProviderLive } from "./GeminiProvider.ts";

// ---------------------------------------------------------------------------
// Spawner helpers (pattern borrowed from ProviderRegistry.test.ts)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(result: { stdout: string; stderr: string; code: number }) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((_command) => Effect.succeed(mockHandle(result))),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

const makeTestLayer = (
  spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  settingsOverrides?: Parameters<typeof ServerSettingsService.layerTest>[0],
) =>
  GeminiProviderLive.pipe(
    Layer.provideMerge(spawnerLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest(settingsOverrides)),
    Layer.provideMerge(NodeServices.layer),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.layer(
  makeTestLayer(mockSpawnerLayer({ stdout: "Google Gemini CLI 0.1.5\n", stderr: "", code: 0 })),
)("GeminiProviderLive – installed and ready", (it) => {
  it.effect("returns ready status when gemini binary is present", () =>
    Effect.gen(function* () {
      const provider = yield* GeminiProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.provider, "gemini");
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.enabled, true);
    }),
  );

  it.effect("includes built-in gemini models in the snapshot", () =>
    Effect.gen(function* () {
      const provider = yield* GeminiProvider;
      const snapshot = yield* provider.refresh;

      const slugs = snapshot.models.map((m) => m.slug);
      assert.ok(slugs.includes("gemini-2.5-pro"), "missing gemini-2.5-pro");
      assert.ok(slugs.includes("gemini-2.5-flash"), "missing gemini-2.5-flash");
    }),
  );
});

it.layer(
  makeTestLayer(failingSpawnerLayer("spawn gemini ENOENT")),
)("GeminiProviderLive – binary not found", (it) => {
  it.effect("returns error status when gemini binary is missing", () =>
    Effect.gen(function* () {
      const provider = yield* GeminiProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.provider, "gemini");
      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.status, "error");
      assert.ok(snapshot.message?.toLowerCase().includes("gemini"), `unexpected message: ${snapshot.message}`);
    }),
  );
});

it.layer(
  makeTestLayer(
    mockSpawnerLayer({ stdout: "", stderr: "", code: 0 }),
    { providers: { gemini: { enabled: false } } },
  ),
)("GeminiProviderLive – disabled", (it) => {
  it.effect("returns disabled status when gemini is turned off in settings", () =>
    Effect.gen(function* () {
      const provider = yield* GeminiProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.provider, "gemini");
      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.status, "disabled");
    }),
  );
});

it.layer(
  makeTestLayer(
    mockSpawnerLayer({ stdout: "Google Gemini CLI 0.1.5\n", stderr: "", code: 0 }),
    { providers: { gemini: { customModels: ["gemini-custom-test"] } } },
  ),
)("GeminiProviderLive – custom models", (it) => {
  it.effect("includes custom model slugs from settings", () =>
    Effect.gen(function* () {
      const provider = yield* GeminiProvider;
      const snapshot = yield* provider.refresh;

      const slugs = snapshot.models.map((m) => m.slug);
      assert.ok(slugs.includes("gemini-custom-test"), "missing custom model");
    }),
  );
});
