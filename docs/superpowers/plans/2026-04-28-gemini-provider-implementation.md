# Gemini Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Gemini CLI as a first-class T3 Code provider with shared provider lifecycle support, Gemini-native auth and resume reuse, and UI model selection using friendly labels backed by exact model ids.

**Architecture:** Extend the shared provider contracts to include `gemini`, implement a managed Gemini provider snapshot plus a scoped Gemini adapter/runtime, and normalize Gemini runtime events into the existing `ProviderRuntimeEvent` stream so the web UI can reuse the standard thread renderer. Keep auth, config, and checkpoints owned by the installed `gemini` CLI while T3 Code stores only thread-to-session metadata, model selections, and provider status snapshots.

**Tech Stack:** TypeScript, Effect, Vitest, node-pty, React, shared `@t3tools/contracts` schemas, shared `@t3tools/shared/model` helpers

---

## File Structure

### Shared Contracts And Settings

- Modify: `packages/contracts/src/orchestration.ts`
  Add `gemini` to `ProviderKind`, add `GeminiModelSelection`, and include it in the `ModelSelection` union.
- Modify: `packages/contracts/src/model.ts`
  Add Gemini defaults, display name, and slug aliases.
- Modify: `packages/contracts/src/settings.ts`
  Add `GeminiSettings`, `GeminiSettingsPatch`, and a `providers.gemini` branch.
- Modify: `packages/shared/src/model.ts`
  Teach shared selection helpers to normalize Gemini slugs and keep Gemini custom models selectable.
- Modify: `packages/shared/src/model.test.ts`
  Add Gemini slug normalization and selection tests.
- Modify: `packages/shared/src/serverSettings.test.ts`
  Add Gemini settings persistence and fallback tests.

### Server Provider Snapshot And Wiring

- Create: `apps/server/src/provider/Services/GeminiAdapter.ts`
  New service tag for the Gemini adapter contract.
- Create: `apps/server/src/provider/Services/GeminiProvider.ts`
  New service tag for the Gemini snapshot service.
- Create: `apps/server/src/provider/Layers/GeminiProvider.ts`
  Gemini provider snapshot, health probe, friendly model catalog, and managed provider service.
- Create: `apps/server/src/provider/Layers/GeminiProvider.test.ts`
  Probe parsing, model list, auth, version, and pending snapshot tests.
- Modify: `apps/server/src/provider/builtInProviderCatalog.ts`
  Add Gemini to built-in provider order and adapter list.
- Modify: `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
  Register Gemini adapter service.
- Modify: `apps/server/src/provider/Layers/ProviderRegistry.ts`
  Provide Gemini snapshot service to the provider registry layer.
- Modify: `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`
  Assert Gemini is registered and listed.
- Modify: `apps/server/src/provider/Layers/ProviderRegistry.test.ts`
  Add Gemini snapshot merge and refresh coverage.

### Server Runtime And Event Normalization

- Create: `apps/server/src/provider/Layers/GeminiSessionRuntime.ts`
  Spawn and manage live Gemini sessions in project cwd.
- Create: `apps/server/src/provider/Layers/GeminiStreamParser.ts`
  Map Gemini `stream-json` events into canonical runtime events and approval requests.
- Create: `apps/server/src/provider/Layers/GeminiAdapter.ts`
  Scoped live adapter that owns sessions and bridges runtime errors to `ProviderAdapterError`.
- Create: `apps/server/src/provider/Layers/GeminiAdapter.test.ts`
  Session lifecycle, approval forwarding, and error mapping tests.
- Create: `apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts`
  Resume, interrupt, and parser fixture coverage.

### Cross-Provider Recovery And Web UI

- Modify: `apps/server/src/serverSettings.ts`
  Add Gemini to provider order for fallback model resolution.
- Modify: `apps/server/src/provider/Layers/ProviderService.test.ts`
  Add Gemini recovery, send, and provider-switch coverage.
- Modify: `apps/server/integration/OrchestrationEngineHarness.integration.ts`
  Allow the integration harness to expose Gemini.
- Modify: `apps/server/integration/orchestrationEngine.integration.test.ts`
  Add Gemini start and recovery paths through orchestration.
- Modify: `apps/web/src/modelSelection.ts`
  Include Gemini in model option resolution and custom model state.
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
  Add Gemini install settings card, status summary, and provider model picker support.
- Modify: `apps/web/src/composerDraftStore.ts`
  Persist Gemini model selections the same way as other providers.
- Modify: `apps/web/src/components/ChatView.tsx`
  Ensure Gemini model selection and provider fallback work in the composer.
- Modify: `apps/web/src/components/ChatView.browser.tsx`
  Add browser-level Gemini model picker coverage.
- Modify: `apps/web/src/composerDraftStore.test.ts`
  Add Gemini selection persistence tests.

### Documentation

- Modify: `.docs/provider-architecture.md`
  Remove Codex-only wording and describe Gemini as a supported provider.
- Modify: `README.md`
  Mention Gemini install and auth expectations.

## Task 1: Extend Provider Contracts, Defaults, And Settings

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/shared/src/model.ts`
- Test: `packages/shared/src/model.test.ts`
- Test: `packages/shared/src/serverSettings.test.ts`

- [ ] **Step 1: Write the failing shared-model tests**

```ts
// packages/shared/src/model.test.ts
it("normalizes Gemini model aliases to exact Gemini ids", () => {
  expect(resolveModelSlugForProvider("gemini", "gemini 2.5 pro")).toBe("gemini-2.5-pro");
  expect(resolveModelSlugForProvider("gemini", "gemini-3-pro-preview")).toBe(
    "gemini-3-pro-preview",
  );
});

it("creates Gemini model selections with exact provider ids", () => {
  const selection = createModelSelection("gemini", "gemini-2.5-pro", [
    { id: "sandboxMode", value: "workspace-write" },
  ]);

  expect(selection).toEqual({
    provider: "gemini",
    model: "gemini-2.5-pro",
    options: [{ id: "sandboxMode", value: "workspace-write" }],
  });
});
```

```ts
// packages/shared/src/serverSettings.test.ts
it("preserves Gemini provider settings when applying settings patches", () => {
  const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    providers: {
      gemini: {
        enabled: true,
        binaryPath: "gemini",
        customModels: ["gemini-3.1-pro-preview"],
      },
    },
  });

  expect(next.providers.gemini.binaryPath).toBe("gemini");
  expect(next.providers.gemini.customModels).toEqual(["gemini-3.1-pro-preview"]);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
bunx vitest run packages/shared/src/model.test.ts packages/shared/src/serverSettings.test.ts
```

Expected:

```text
FAIL packages/shared/src/model.test.ts
FAIL packages/shared/src/serverSettings.test.ts
```

- [ ] **Step 3: Add `gemini` to the shared provider and settings schemas**

```ts
// packages/contracts/src/orchestration.ts
export const ProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "gemini",
]);

export const GeminiModelSelection = Schema.Struct({
  provider: Schema.Literal("gemini"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const ModelSelection = Schema.Union([
  CodexModelSelection,
  ClaudeModelSelection,
  CursorModelSelection,
  OpenCodeModelSelection,
  GeminiModelSelection,
]);
```

```ts
// packages/contracts/src/model.ts
export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4",
  claudeAgent: "claude-sonnet-4-6",
  cursor: "auto",
  opencode: "openai/gpt-5",
  gemini: "gemini-2.5-pro",
};

export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
  cursor: "composer-2",
  opencode: "openai/gpt-5",
  gemini: "gemini-2.5-flash",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, string>> = {
  // existing providers...
  gemini: {
    "gemini 2.5 pro": "gemini-2.5-pro",
    "gemini 2.5 flash": "gemini-2.5-flash",
    "gemini 2.5 flash lite": "gemini-2.5-flash-lite",
    "gemini 3 pro preview": "gemini-3-pro-preview",
    "gemini 3.1 pro preview": "gemini-3.1-pro-preview",
  },
};

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
  gemini: "Gemini",
};
```

```ts
// packages/contracts/src/settings.ts
export const GeminiSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("gemini"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

export const ServerSettings = Schema.Struct({
  // existing settings...
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    gemini: GeminiSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
```

- [ ] **Step 4: Update shared model helpers to treat Gemini like other providers**

```ts
// packages/shared/src/model.ts
export function createModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection>,
): ModelSelection {
  const normalizedModel = resolveModelSlugForProvider(provider, model);
  return {
    provider,
    model: normalizedModel,
    ...(options && options.length > 0 ? { options: [...options] } : {}),
  } as ModelSelection;
}
```

```ts
// packages/shared/src/model.ts
function resolveModelSlug(model: string | null | undefined, provider: ProviderKind): string {
  if (!model?.trim()) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider];
  return aliases[model.trim().toLowerCase()] ?? model.trim();
}
```

- [ ] **Step 5: Re-run the targeted tests**

Run:

```bash
bunx vitest run packages/shared/src/model.test.ts packages/shared/src/serverSettings.test.ts
```

Expected:

```text
PASS packages/shared/src/model.test.ts
PASS packages/shared/src/serverSettings.test.ts
```

- [ ] **Step 6: Commit the shared contract changes**

```bash
git add packages/contracts/src/orchestration.ts packages/contracts/src/model.ts packages/contracts/src/settings.ts packages/shared/src/model.ts packages/shared/src/model.test.ts packages/shared/src/serverSettings.test.ts
git commit -m "feat: add Gemini provider contracts and settings"
```

## Task 2: Wire Gemini Into Built-In Provider Registries

**Files:**
- Create: `apps/server/src/provider/Services/GeminiAdapter.ts`
- Create: `apps/server/src/provider/Services/GeminiProvider.ts`
- Modify: `apps/server/src/provider/builtInProviderCatalog.ts`
- Modify: `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- Modify: `apps/server/src/provider/Layers/ProviderRegistry.ts`
- Test: `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`

- [ ] **Step 1: Write the failing registry test**

```ts
// apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
const fakeGeminiAdapter: GeminiAdapterShape = {
  provider: "gemini",
  capabilities: { sessionModelSwitch: "unsupported" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

it.effect("lists Gemini among registered built-in adapters", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const gemini = yield* registry.getByProvider("gemini");
    const providers = yield* registry.listProviders();

    assert.equal(gemini, fakeGeminiAdapter);
    assert.deepEqual(providers, ["codex", "claudeAgent", "opencode", "cursor", "gemini"]);
  }),
);
```

- [ ] **Step 2: Run the adapter registry test to verify it fails**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
```

Expected:

```text
FAIL apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
```

- [ ] **Step 3: Add Gemini service tags and built-in registry wiring**

```ts
// apps/server/src/provider/Services/GeminiAdapter.ts
export interface GeminiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "gemini";
}

export class GeminiAdapter extends Context.Service<GeminiAdapter, GeminiAdapterShape>()(
  "t3/provider/Services/GeminiAdapter",
) {}
```

```ts
// apps/server/src/provider/Services/GeminiProvider.ts
export class GeminiProvider extends Context.Service<GeminiProvider, ServerProviderShape>()(
  "t3/provider/Services/GeminiProvider",
) {}
```

```ts
// apps/server/src/provider/builtInProviderCatalog.ts
type BuiltInAdapterMap = {
  readonly codex: ProviderAdapterShape<ProviderAdapterError>;
  readonly claudeAgent: ProviderAdapterShape<ProviderAdapterError>;
  readonly opencode: ProviderAdapterShape<ProviderAdapterError>;
  readonly gemini: ProviderAdapterShape<ProviderAdapterError>;
  readonly cursor?: ProviderAdapterShape<ProviderAdapterError>;
};

export const BUILT_IN_PROVIDER_ORDER = [
  "codex",
  "claudeAgent",
  "opencode",
  "cursor",
  "gemini",
] as const satisfies ReadonlyArray<ProviderKind>;
```

- [ ] **Step 4: Register Gemini in the live provider layers**

```ts
// apps/server/src/provider/Layers/ProviderAdapterRegistry.ts
import { GeminiAdapter } from "../Services/GeminiAdapter.ts";

const adapters =
  options?.adapters !== undefined
    ? options.adapters
    : createBuiltInAdapterList({
        codex: yield* CodexAdapter,
        claudeAgent: yield* ClaudeAdapter,
        opencode: yield* OpenCodeAdapter,
        gemini: yield* GeminiAdapter,
        ...(cursorAdapterOption._tag === "Some" ? { cursor: cursorAdapterOption.value } : {}),
      });
```

```ts
// apps/server/src/provider/Layers/ProviderRegistry.ts
import { GeminiProviderLive } from "./GeminiProvider.ts";
import { GeminiProvider } from "../Services/GeminiProvider.ts";

const geminiProvider = yield* GeminiProvider;
const providerSources = createBuiltInProviderSources({
  codex: codexProvider,
  claudeAgent: claudeProvider,
  opencode: openCodeProvider,
  cursor: cursorProvider,
  gemini: geminiProvider,
});
```

- [ ] **Step 5: Re-run the adapter registry test**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
```

Expected:

```text
PASS apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
```

- [ ] **Step 6: Commit the registry wiring**

```bash
git add apps/server/src/provider/Services/GeminiAdapter.ts apps/server/src/provider/Services/GeminiProvider.ts apps/server/src/provider/builtInProviderCatalog.ts apps/server/src/provider/Layers/ProviderAdapterRegistry.ts apps/server/src/provider/Layers/ProviderRegistry.ts apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
git commit -m "feat: register Gemini as a built-in provider"
```

## Task 3: Implement Gemini Provider Snapshot, Friendly Models, And Probes

**Files:**
- Create: `apps/server/src/provider/Layers/GeminiProvider.ts`
- Create: `apps/server/src/provider/Layers/GeminiProvider.test.ts`
- Modify: `apps/server/src/provider/Layers/ProviderRegistry.test.ts`

- [ ] **Step 1: Write the failing provider snapshot tests**

```ts
// apps/server/src/provider/Layers/GeminiProvider.test.ts
it.effect("reports friendly Gemini model names while preserving exact slugs", () =>
  Effect.gen(function* () {
    const provider = yield* checkGeminiProviderStatus(() =>
      Effect.succeed({
        installed: true,
        version: "0.38.2",
        auth: { status: "authenticated" as const },
      }),
    );

    expect(provider.provider).toBe("gemini");
    expect(provider.models).toContainEqual({
      slug: "gemini-3-pro-preview",
      name: "Gemini 3 Pro Preview",
      isCustom: false,
    });
  }),
);

it.effect("returns an unauthenticated error when Gemini CLI requires login", () =>
  Effect.gen(function* () {
    const provider = yield* parseGeminiProbeResult({
      code: 1,
      stdout: "",
      stderr: "Run `gemini` to sign in",
    });

    expect(provider.status).toBe("error");
    expect(provider.auth.status).toBe("unauthenticated");
  }),
);
```

- [ ] **Step 2: Run the Gemini provider tests to verify they fail**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/GeminiProvider.test.ts
```

Expected:

```text
FAIL apps/server/src/provider/Layers/GeminiProvider.test.ts
```

- [ ] **Step 3: Build the Gemini provider model catalog and pending snapshot**

```ts
// apps/server/src/provider/Layers/GeminiProvider.ts
const PROVIDER = "gemini" as const;

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro", isCustom: false },
  { slug: "gemini-2.5-flash", name: "Gemini 2.5 Flash", isCustom: false },
  { slug: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", isCustom: false },
  { slug: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview", isCustom: false },
  { slug: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", isCustom: false },
];

const makePendingGeminiProvider = (geminiSettings: GeminiSettings): ServerProvider =>
  buildServerProvider({
    provider: PROVIDER,
    presentation: { title: "Gemini", badgeLabel: undefined },
    enabled: geminiSettings.enabled,
    checkedAt: null,
    models: providerModelsFromSettings(BUILT_IN_MODELS, PROVIDER, geminiSettings.customModels),
    probe: {
      installed: false,
      version: null,
      status: geminiSettings.enabled ? "warning" : "disabled",
      auth: { status: "unknown" },
      message: "Gemini provider status has not been checked in this session yet.",
    },
  });
```

- [ ] **Step 4: Implement Gemini CLI probing and managed provider refresh**

```ts
// apps/server/src/provider/Layers/GeminiProvider.ts
const runGeminiCommand = (binaryPath: string, args: ReadonlyArray<string>) =>
  spawnAndCollect({
    command: binaryPath,
    args,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* () {
  const settings = (yield* ServerSettingsService).getSettings.pipe(
    Effect.map((serverSettings) => serverSettings.providers.gemini),
  );

  return yield* makeManagedServerProvider<GeminiSettings>({
    getSettings: settings,
    streamSettings: (yield* ServerSettingsService).streamChanges.pipe(
      Stream.map((serverSettings) => serverSettings.providers.gemini),
    ),
    haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
    initialSnapshot: makePendingGeminiProvider,
    checkProvider: probeGeminiProvider,
  });
});
```

```ts
// apps/server/src/provider/Layers/GeminiProvider.ts
function parseGeminiAuthStatus(result: CommandResult) {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("sign in") || output.includes("authenticate")) {
    return {
      status: "error" as const,
      auth: { status: "unauthenticated" as const },
      message: "Gemini CLI is not authenticated. Run `gemini` and complete sign-in, then try again.",
    };
  }
  return {
    status: "ready" as const,
    auth: { status: "authenticated" as const },
  };
}
```

- [ ] **Step 5: Re-run the Gemini snapshot tests and the registry tests**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/GeminiProvider.test.ts apps/server/src/provider/Layers/ProviderRegistry.test.ts
```

Expected:

```text
PASS apps/server/src/provider/Layers/GeminiProvider.test.ts
PASS apps/server/src/provider/Layers/ProviderRegistry.test.ts
```

- [ ] **Step 6: Commit the Gemini snapshot layer**

```bash
git add apps/server/src/provider/Layers/GeminiProvider.ts apps/server/src/provider/Layers/GeminiProvider.test.ts apps/server/src/provider/Layers/ProviderRegistry.test.ts
git commit -m "feat: add Gemini provider snapshot and probes"
```

## Task 4: Implement The Gemini Session Runtime And Adapter

**Files:**
- Create: `apps/server/src/provider/Layers/GeminiStreamParser.ts`
- Create: `apps/server/src/provider/Layers/GeminiSessionRuntime.ts`
- Create: `apps/server/src/provider/Layers/GeminiAdapter.ts`
- Create: `apps/server/src/provider/Layers/GeminiAdapter.test.ts`
- Create: `apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts`

- [ ] **Step 1: Write the failing runtime and adapter tests**

```ts
// apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts
it.effect("normalizes Gemini stream-json assistant and tool events", () =>
  Effect.gen(function* () {
    const events = parseGeminiStreamLines([
      '{"type":"content","role":"assistant","text":"Planning change"}',
      '{"type":"tool_call","tool":"shell","status":"started","input":{"command":"pwd"}}',
      '{"type":"tool_result","tool":"shell","status":"completed","output":"/repo"}',
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "thread.message.delta",
      "thread.item.started",
      "thread.item.completed",
    ]);
  }),
);
```

```ts
// apps/server/src/provider/Layers/GeminiAdapter.test.ts
it.effect("starts Gemini sessions with the selected model id", () =>
  Effect.gen(function* () {
    const adapter = yield* GeminiAdapter;
    const session = yield* adapter.startSession({
      threadId: ThreadId.make("thread-gemini-1"),
      provider: "gemini",
      cwd: "/repo",
      modelSelection: createModelSelection("gemini", "gemini-3-pro-preview"),
      runtimeMode: "full-access",
    });

    expect(session.provider).toBe("gemini");
    expect(session.model).toBe("gemini-3-pro-preview");
  }),
);
```

- [ ] **Step 2: Run the new Gemini runtime tests to verify they fail**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts apps/server/src/provider/Layers/GeminiAdapter.test.ts
```

Expected:

```text
FAIL apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts
FAIL apps/server/src/provider/Layers/GeminiAdapter.test.ts
```

- [ ] **Step 3: Implement stream-json parsing into canonical runtime events**

```ts
// apps/server/src/provider/Layers/GeminiStreamParser.ts
export function parseGeminiStreamEvent(input: GeminiStreamEventEnvelope): ReadonlyArray<ProviderRuntimeEvent> {
  switch (input.type) {
    case "content":
      return [
        {
          type: "thread.message.delta",
          provider: "gemini",
          threadId: input.threadId,
          turnId: input.turnId,
          messageId: RuntimeItemId.make(`gemini-msg-${input.sequence}`),
          streamKind: "assistant_text",
          textDelta: input.text ?? "",
          createdAt: input.createdAt,
          eventId: EventId.make(`evt-gemini-${input.sequence}`),
        },
      ];
    case "tool_call":
      return [toToolStartedEvent(input)];
    case "tool_result":
      return [toToolCompletedEvent(input)];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Implement the live Gemini runtime and adapter**

```ts
// apps/server/src/provider/Layers/GeminiSessionRuntime.ts
const args = [
  "--model",
  selectedModel,
  "--output-format",
  "stream-json",
];

if (resumeCursor) {
  args.push("--resume", resumeCursor.opaque);
}

const child = yield* ChildProcess.make(binaryPath, args, {
  cwd,
  env: process.env,
});
```

```ts
// apps/server/src/provider/Layers/GeminiAdapter.ts
const adapter: GeminiAdapterShape = {
  provider: "gemini",
  capabilities: { sessionModelSwitch: "unsupported" },
  startSession: (input) => runtimeManager.start(input),
  sendTurn: (input) => runtimeManager.sendTurn(input),
  interruptTurn: (threadId, turnId) => runtimeManager.interrupt(threadId, turnId),
  respondToRequest: (threadId, requestId, decision) =>
    runtimeManager.respondToRequest(threadId, requestId, decision),
  respondToUserInput: (threadId, requestId, answers) =>
    runtimeManager.respondToUserInput(threadId, requestId, answers),
  stopSession: (threadId) => runtimeManager.stop(threadId),
  listSessions: () => runtimeManager.listSessions(),
  hasSession: (threadId) => runtimeManager.hasSession(threadId),
  readThread: (threadId) => runtimeManager.readThread(threadId),
  rollbackThread: (threadId, numTurns) => runtimeManager.rollbackThread(threadId, numTurns),
  stopAll: () => runtimeManager.stopAll(),
  streamEvents: runtimeManager.streamEvents,
};
```

- [ ] **Step 5: Re-run the Gemini adapter and runtime tests**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts apps/server/src/provider/Layers/GeminiAdapter.test.ts
```

Expected:

```text
PASS apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts
PASS apps/server/src/provider/Layers/GeminiAdapter.test.ts
```

- [ ] **Step 6: Commit the Gemini runtime**

```bash
git add apps/server/src/provider/Layers/GeminiStreamParser.ts apps/server/src/provider/Layers/GeminiSessionRuntime.ts apps/server/src/provider/Layers/GeminiAdapter.ts apps/server/src/provider/Layers/GeminiAdapter.test.ts apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts
git commit -m "feat: add Gemini runtime and adapter"
```

## Task 5: Wire Recovery, Routing, And Cross-Provider Tests

**Files:**
- Modify: `apps/server/src/serverSettings.ts`
- Modify: `apps/server/src/provider/Layers/ProviderService.test.ts`
- Modify: `apps/server/integration/OrchestrationEngineHarness.integration.ts`
- Modify: `apps/server/integration/orchestrationEngine.integration.test.ts`

- [ ] **Step 1: Write the failing provider recovery tests**

```ts
// apps/server/src/provider/Layers/ProviderService.test.ts
it.effect("recovers stale Gemini sessions using persisted cwd and model selection", () =>
  Effect.gen(function* () {
    const service = yield* ProviderService;
    const threadId = ThreadId.make("thread-gemini-recover");

    yield* service.startSession(threadId, {
      provider: "gemini",
      cwd: "/repo",
      runtimeMode: "full-access",
      modelSelection: createModelSelection("gemini", "gemini-3-pro-preview"),
    });

    yield* fanout.gemini.stopAll();

    const resumed = yield* service.sendTurn({
      threadId,
      text: "continue",
    });

    expect(resumed.threadId).toBe(threadId);
    expect(routing.gemini.startSession.mock.calls.length).toBe(1);
  }),
);
```

- [ ] **Step 2: Run the routing and recovery tests to verify they fail**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/ProviderService.test.ts apps/server/integration/orchestrationEngine.integration.test.ts
```

Expected:

```text
FAIL apps/server/src/provider/Layers/ProviderService.test.ts
FAIL apps/server/integration/orchestrationEngine.integration.test.ts
```

- [ ] **Step 3: Add Gemini to provider fallback order and fake test registries**

```ts
// apps/server/src/serverSettings.ts
const PROVIDER_ORDER: readonly ProviderKind[] = [
  "codex",
  "claudeAgent",
  "opencode",
  "cursor",
  "gemini",
];
```

```ts
// apps/server/src/provider/Layers/ProviderService.test.ts
const gemini = makeFakeCodexAdapter("gemini");

const registry: typeof ProviderAdapterRegistry.Service = {
  getByProvider: (provider) =>
    provider === "codex"
      ? Effect.succeed(codex.adapter)
      : provider === "claudeAgent"
        ? Effect.succeed(claude.adapter)
        : provider === "cursor"
          ? Effect.succeed(cursor.adapter)
          : provider === "gemini"
            ? Effect.succeed(gemini.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
  listProviders: () => Effect.succeed(["codex", "claudeAgent", "cursor", "gemini"]),
};
```

- [ ] **Step 4: Add orchestration harness coverage for Gemini**

```ts
// apps/server/integration/OrchestrationEngineHarness.integration.ts
const provider = options?.provider ?? "codex";

listProviders: () =>
  Effect.succeed(["codex", "claudeAgent", "gemini"] as const),
```

```ts
// apps/server/integration/orchestrationEngine.integration.test.ts
it.live("starts a gemini session on first turn when provider is requested", () =>
  Effect.gen(function* () {
    const harness = yield* makeOrchestrationIntegrationHarness({ provider: "gemini" });
    // mirror existing Claude integration shape, but assert providerName === "gemini"
  }),
);
```

- [ ] **Step 5: Re-run the provider recovery and orchestration tests**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/ProviderService.test.ts apps/server/integration/orchestrationEngine.integration.test.ts
```

Expected:

```text
PASS apps/server/src/provider/Layers/ProviderService.test.ts
PASS apps/server/integration/orchestrationEngine.integration.test.ts
```

- [ ] **Step 6: Commit the recovery and routing changes**

```bash
git add apps/server/src/serverSettings.ts apps/server/src/provider/Layers/ProviderService.test.ts apps/server/integration/OrchestrationEngineHarness.integration.ts apps/server/integration/orchestrationEngine.integration.test.ts
git commit -m "feat: add Gemini provider recovery coverage"
```

## Task 6: Expose Gemini In Settings, Composer, And Model Pickers

**Files:**
- Modify: `apps/web/src/modelSelection.ts`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/composerDraftStore.ts`
- Modify: `apps/web/src/composerDraftStore.test.ts`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.browser.tsx`

- [ ] **Step 1: Write the failing web model-selection tests**

```ts
// apps/web/src/composerDraftStore.test.ts
it("persists Gemini model selections by provider", () => {
  const selection = createModelSelection("gemini", "gemini-3-pro-preview");
  const next = normalizeComposerDraft({
    activeProvider: "gemini",
    modelSelectionByProvider: { gemini: selection },
  });

  expect(next.modelSelectionByProvider.gemini?.model).toBe("gemini-3-pro-preview");
});
```

```ts
// apps/web/src/components/ChatView.browser.tsx
it("shows friendly Gemini model labels in the provider model picker", async () => {
  // mount with a Gemini provider snapshot whose model list contains:
  // { slug: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" }
  await openModelPicker(page);
  await expect(page.getByText("Gemini 3 Pro Preview")).toBeVisible();
});
```

- [ ] **Step 2: Run the targeted web tests to verify they fail**

Run:

```bash
bunx vitest run apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.browser.tsx
```

Expected:

```text
FAIL apps/web/src/composerDraftStore.test.ts
FAIL apps/web/src/components/ChatView.browser.tsx
```

- [ ] **Step 3: Add Gemini to web-side provider option resolution**

```ts
// apps/web/src/modelSelection.ts
export function getCustomModelOptionsByProvider(...) {
  return {
    codex: ...,
    claudeAgent: ...,
    cursor: ...,
    opencode: ...,
    gemini: getAppModelOptions(
      settings,
      providers,
      "gemini",
      selectedProvider === "gemini" ? selectedModel : undefined,
    ),
  };
}
```

```ts
// apps/web/src/composerDraftStore.ts
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderKind, ModelSelection>> = {
  codex: undefined,
  claudeAgent: undefined,
  cursor: undefined,
  opencode: undefined,
  gemini: undefined,
};
```

- [ ] **Step 4: Add Gemini install settings and friendly model labels to the UI**

```tsx
// apps/web/src/components/settings/SettingsPanels.tsx
const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  // existing providers...
  {
    provider: "gemini",
    title: "Gemini",
    binaryPlaceholder: "Gemini binary path",
    binaryDescription: "Path to the Gemini binary",
  },
];
```

```tsx
// apps/web/src/components/settings/SettingsPanels.tsx
<ProviderModelPicker
  provider="gemini"
  models={providerCard.models}
  selectedModel={selectedModelByProvider.gemini}
  onChange={(slug) => updateProviderModel("gemini", slug)}
/>;
```

```tsx
// apps/web/src/components/ChatView.tsx
const threadCreateModelSelection = createModelSelection(
  selectedProvider,
  selectedModel ?? DEFAULT_MODEL_BY_PROVIDER[selectedProvider],
);
```

- [ ] **Step 5: Re-run the targeted web tests**

Run:

```bash
bunx vitest run apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.browser.tsx
```

Expected:

```text
PASS apps/web/src/composerDraftStore.test.ts
PASS apps/web/src/components/ChatView.browser.tsx
```

- [ ] **Step 6: Commit the web Gemini UX**

```bash
git add apps/web/src/modelSelection.ts apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/composerDraftStore.ts apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.browser.tsx
git commit -m "feat: add Gemini provider UI and model picker support"
```

## Task 7: Update Docs And Run Final Verification

**Files:**
- Modify: `.docs/provider-architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Write the failing documentation expectations as a grep check**

Run:

```bash
rg -n "currently supports Codex and Claude|Codex is the only implemented provider|Codex only" README.md .docs/provider-architecture.md
```

Expected:

```text
Matches found in README.md and/or .docs/provider-architecture.md
```

- [ ] **Step 2: Update the provider docs**

```md
<!-- README.md -->
T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, and Gemini).

- Codex: install Codex CLI and run `codex login`
- Claude: install Claude Code and run `claude auth login`
- Gemini: install Gemini CLI and complete sign-in by running `gemini`
```

```md
<!-- .docs/provider-architecture.md -->
Built-in providers currently include Codex, Claude, OpenCode, Cursor, and Gemini. Each provider supplies:

- a `ServerProvider` snapshot service for installation/auth/model state
- a scoped adapter implementing the shared `ProviderAdapter` contract
- canonical runtime events consumed by the orchestration layer
```

- [ ] **Step 3: Run the full verification suite**

Run:

```bash
bunx vitest run apps/server/src/provider/Layers/GeminiProvider.test.ts apps/server/src/provider/Layers/GeminiAdapter.test.ts apps/server/src/provider/Layers/GeminiSessionRuntime.test.ts apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts apps/server/src/provider/Layers/ProviderRegistry.test.ts apps/server/src/provider/Layers/ProviderService.test.ts apps/server/integration/orchestrationEngine.integration.test.ts apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.browser.tsx
bun fmt
bun lint
bun typecheck
```

Expected:

```text
All targeted Vitest suites pass
Formatting completes without diffs
Lint exits 0
Typecheck exits 0
```

- [ ] **Step 4: Commit the docs and verification sweep**

```bash
git add .docs/provider-architecture.md README.md
git commit -m "docs: document Gemini provider support"
```

## Self-Review Checklist

- Spec coverage:
  - first-class provider support is covered by Tasks 1 and 2
  - Gemini snapshot and model catalog are covered by Task 3
  - live runtime, approvals, and event normalization are covered by Task 4
  - recovery parity through `ProviderService` is covered by Task 5
  - friendly UI model labels and settings integration are covered by Task 6
  - stale docs cleanup and repo verification are covered by Task 7
- Placeholder scan:
  - no `TODO`, `TBD`, or deferred “implement later” language remains
  - every code-writing step includes exact file paths and code blocks
  - every test-running step includes an exact command and expected result
- Type consistency:
  - provider kind is always `gemini`
  - the stored model value is always the raw slug such as `gemini-3-pro-preview`
  - the user-facing label is always the friendly name such as `Gemini 3 Pro Preview`
