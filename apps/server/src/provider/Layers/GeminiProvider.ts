/**
 * GeminiProviderLive – Live layer for the Gemini provider snapshot service.
 *
 * Watches GeminiSettings for changes, probes the Gemini CLI binary, and
 * publishes server-provider snapshots (models, auth, version) to the
 * ProviderRegistry.
 *
 * NOTE: Full probe implementation (model catalogue fetch, auth status) is
 * being built in Task 3. This layer currently returns a pending snapshot.
 *
 * @module GeminiProviderLive
 */
import { DateTime, Duration, Effect, Equal, Layer, Stream } from "effect";

import type { GeminiSettings, ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { GeminiProvider } from "../Services/GeminiProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "gemini" as const;
const GEMINI_PRESENTATION = {
  displayName: "Gemini",
  showInteractionModeToggle: false,
} as const;
const GEMINI_PROBE_TIMEOUT_MS = 8_000;
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

const checkGeminiProviderStatus = Effect.gen(function* () {
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

  // TODO(Task 3): Replace with live gemini CLI probe.
  // For now, optimistically report as installed/ready so the provider
  // is usable once the session runtime is wired in Task 4.
  return buildServerProvider({
    provider: PROVIDER,
    presentation: GEMINI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const GeminiProviderLive = Layer.effect(
  GeminiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const checkProvider = checkGeminiProviderStatus.pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
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
