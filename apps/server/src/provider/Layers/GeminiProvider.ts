/**
 * GeminiProviderLive – Live layer for the Gemini provider snapshot service.
 *
 * Watches GeminiSettings for changes, probes the Gemini CLI binary, and
 * publishes server-provider snapshots (models, auth, version) to the
 * ProviderRegistry.
 *
 * @module GeminiProviderLive
 */
import { DateTime, Duration, Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { GeminiSettings, ServerProvider } from "@t3tools/contracts";
import { ServerSettingsError } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { GeminiProvider } from "../Services/GeminiProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "gemini" as const;
const GEMINI_PRESENTATION = {
  displayName: "Gemini",
  showInteractionModeToggle: false,
} as const;

const GEMINI_BUILT_IN_MODELS = [
  { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro", isCustom: false as const, capabilities: null },
  {
    slug: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    isCustom: false as const,
    capabilities: null,
  },
] as const;

const GEMINI_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

function geminiModelsFromSettings(settings: GeminiSettings): ServerProvider["models"] {
  return providerModelsFromSettings(
    [...GEMINI_BUILT_IN_MODELS],
    PROVIDER,
    settings.customModels,
    GEMINI_CAPABILITIES,
  );
}

const makePendingGeminiProvider = (settings: GeminiSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = geminiModelsFromSettings(settings);

  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    presentation: GEMINI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Gemini provider status has not been checked in this session yet.",
    },
  });
};

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const runGeminiCommand = Effect.fn("runGeminiCommand")(function* (
  args: ReadonlyArray<string>,
): Effect.fn.Return<
  { stdout: string; stderr: string; code: number },
  Error,
  ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
> {
  const geminiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.gemini),
  );
  const command = ChildProcess.make(geminiSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(geminiSettings.binaryPath, command);
});

export const checkGeminiProviderStatus: Effect.Effect<
  ServerProvider,
  ServerSettingsError,
  ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const settings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((s) => s.providers.gemini),
  );
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = geminiModelsFromSettings(settings);

  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runGeminiCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    const missing = isCommandMissingCause(error);
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini CLI is installed but timed out during version check.",
      },
    });
  }

  const versionResult = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);

  if (versionResult.code !== 0) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini CLI is installed but failed to run version check.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    presentation: GEMINI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const GeminiProviderLive = Layer.effect(
  GeminiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkGeminiProviderStatus.pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<GeminiSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.gemini),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.gemini),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingGeminiProvider,
      checkProvider,
      refreshInterval: Duration.minutes(5),
    });
  }),
);
