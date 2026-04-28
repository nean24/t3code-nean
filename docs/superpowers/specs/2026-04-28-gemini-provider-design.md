# Gemini Provider Design For T3 Code

## Summary

Add Google Gemini CLI as a first-class provider in T3 Code with parity goals matching the existing Codex and Claude provider experience:

- provider selection in settings and composer
- session lifecycle through the shared provider service
- thread persistence and resume behavior
- approval and tool rendering in the existing thread UI
- model selection in the UI using friendly names backed by exact Gemini model ids

The implementation must wrap the installed `gemini` binary and reuse Gemini CLI's own authentication, configuration, checkpoint, and project-scoped session behavior. T3 Code must not introduce a separate Gemini auth stack.

## Current Repository Context

The local repository already has a generic provider architecture with multiple provider kinds in contracts and server routing:

- `packages/contracts/src/model.ts` defines provider defaults, aliases, display names, and provider option descriptors.
- `apps/server/src/provider/Services/ProviderAdapter.ts` defines the adapter contract used by all providers.
- `apps/server/src/provider/Layers/ProviderService.ts` owns cross-provider session recovery, event fanout, and validation.
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` binds provider kinds to concrete adapters.

The repository is in a transitional state:

- `.docs/provider-architecture.md` still says Codex is the only implemented provider.
- the codebase already includes `claudeAgent`, `cursor`, and `opencode` contract-level support.
- the Gemini design should therefore target the code reality, not the stale doc sentence.

## Product Goals

1. Gemini must appear as a built-in provider alongside the other first-class providers.
2. Gemini sessions must feel continuous, not like stateless one-shot requests.
3. Model selection must be available in the UI and use readable names such as `Gemini 3 Pro Preview`.
4. The runtime must preserve Gemini CLI-native behavior for auth, approvals, tools, checkpoints, and resume wherever possible.
5. Failures must produce actionable guidance instead of opaque provider errors.

## Non-Goals

- Building a custom Gemini authentication flow inside T3 Code.
- Reimplementing Gemini CLI logic with direct API calls.
- Inventing a Gemini-only thread renderer in the web app.
- Hiding Gemini model ids entirely from the system. The UI can prefer friendly names, but the backend must continue to use exact model ids.

## Considered Approaches

### 1. Headless Per-Turn JSON Invocations

Run `gemini -p ... --output-format json` or `stream-json` for each turn and reconstruct thread state in T3 Code.

Pros:

- easier to parse in isolation
- easier to unit test
- lower PTY complexity

Cons:

- weak fit for long-lived interactive sessions
- poor parity for approvals, slash-command semantics, and checkpoint resume
- higher risk of behavior drift from real Gemini CLI

### 2. Pure Interactive PTY Adapter

Run Gemini entirely as an interactive terminal process and infer everything from PTY traffic.

Pros:

- closest to native Gemini behavior
- strongest parity for interactive flows

Cons:

- more brittle parsing
- weaker observability for structured events
- harder to probe capabilities, auth, and model support cleanly

### 3. Hybrid Adapter

Use structured Gemini CLI invocations for probing and capability discovery, but run live sessions through an interactive managed process.

Pros:

- best match for parity and UX goals
- preserves Gemini-native runtime behavior
- keeps health checks and model metadata more reliable
- aligns with the repository's existing split between provider snapshot logic and provider session runtime

Cons:

- broader implementation surface than a headless-only adapter

## Recommended Approach

Adopt the hybrid adapter.

This keeps session runtime close to the real Gemini CLI while still allowing T3 Code to expose clean provider status, model metadata, and recovery behavior. It is the safest path to a first-class provider that users can treat like the built-in Codex and Claude paths rather than a reduced compatibility mode.

## Architecture

### Provider Kind And Shared Contracts

Add a new provider kind for Gemini across the shared schema packages and provider catalogs.

Expected contract touchpoints:

- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/model.ts`
- any provider snapshot or settings schemas that enumerate provider kinds
- shared model helpers in `packages/shared/src/model.ts`

Required contract additions:

- provider kind: `gemini`
- provider display name: `Gemini`
- default model mapping for Gemini
- model alias normalization for Gemini-friendly shorthands if needed
- provider option descriptors for any Gemini-specific selectable settings that belong in model selection

The default provider behavior must remain unchanged for non-Gemini users.

### Server Adapter Layer

Create a Gemini adapter service parallel to the existing provider services.

Expected server touchpoints:

- `apps/server/src/provider/Services/GeminiAdapter.ts`
- `apps/server/src/provider/Layers/GeminiProvider.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/server/src/provider/builtInProviderCatalog.ts`

Responsibilities:

- detect whether `gemini` is installed and runnable
- detect provider health and auth state by delegating to Gemini CLI behavior
- expose built-in Gemini models and custom model support
- start, resume, interrupt, stop, and respond to approval or user-input requests
- normalize Gemini runtime output into the shared `ProviderRuntimeEvent` stream

### Runtime Model

Gemini sessions must be long-lived managed processes rather than one process per turn.

The runtime must:

- launch `gemini` in the thread's project cwd
- pass model selection on start using exact model ids
- preserve session continuity between turns
- support shared provider recovery in `ProviderService`
- persist resume state in the same provider session directory used by other providers

`ProviderService` recovery behavior already expects persisted `resumeCursor`, `cwd`, and `modelSelection`. Gemini must conform to that pattern so stale sessions can be recovered through existing orchestration paths instead of bespoke logic.

## Gemini CLI Reuse Strategy

T3 Code will reuse Gemini CLI state rather than supersede it.

Specifically:

- authentication remains owned by Gemini CLI
- config resolution remains owned by Gemini CLI
- project `.gemini` behavior remains owned by Gemini CLI
- checkpoint and resume behavior must use Gemini CLI-native mechanisms where possible

T3 Code may cache probe results and store thread-to-session metadata, but it must not become the source of truth for Gemini auth or session semantics.

## Session Start And Resume

### Start

Starting a new Gemini-backed session must:

1. resolve the selected Gemini model id
2. start the Gemini process in the thread cwd
3. attach runtime ingestion
4. persist the binding through `ProviderSessionDirectory`

### Resume

Gemini resume must prefer the CLI's own checkpoint or resume mechanics.

The persisted state in T3 Code should track enough data to reopen the Gemini session in the same project context:

- provider kind
- runtime mode
- cwd
- selected model
- Gemini resume cursor or checkpoint identity

If resume data is missing or invalid, T3 Code should fail explicitly and offer a clean new-session path instead of pretending recovery succeeded.

Resume must remain project-scoped to match Gemini CLI behavior.

## Model Selection UX

### Display Rules

Gemini must support model selection in the UI like the other built-in providers.

The primary UI label must be a human-readable friendly name, for example:

- `Gemini 2.5 Pro`
- `Gemini 2.5 Flash`
- `Gemini 2.5 Flash-Lite`
- `Gemini 3 Pro Preview`
- `Gemini 3.1 Pro Preview`

The backing stored value must remain the exact Gemini model id, for example:

- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`
- `gemini-3-pro-preview`
- `gemini-3.1-pro-preview`

Raw ids may appear in a tooltip or secondary description, but never as the main visible label in the picker.

### Source Of Truth

The model picker must use a provider model catalog owned by the Gemini provider layer.

That catalog must include:

- friendly label
- exact model id
- `isDefault`
- `isCustom`
- optional capability metadata

### Supported Selection Modes

Gemini model selection must support:

- built-in curated models with friendly labels
- custom model ids entered manually
- persisted selection per the existing model selection system

The picker must not use generic labels such as `Auto`, `Pro`, or `Flash` as primary visible options. If Gemini aliases are supported internally, they must be treated as implementation details or secondary descriptions only.

## Provider Snapshot And Health Probing

Gemini provider status must be surfaced through the same provider snapshot pattern as other providers.

The probe phase must attempt to determine:

- binary presence
- CLI version
- auth status or best-effort auth health
- available Gemini model families supported by the installed CLI version
- warnings for outdated versions, unsupported models, or incomplete capabilities

Error states must be differentiated:

- `gemini` command missing
- binary exists but fails to run
- authentication required
- installed CLI too old
- selected model unavailable

User-facing messages must be actionable, for example recommending `npm install -g @google/gemini-cli@latest`, launching `gemini`, or selecting a different model.

## Event Normalization

Gemini runtime output must be translated into the existing provider runtime event stream instead of introducing Gemini-specific rendering branches in the UI.

The normalized event set must cover:

- assistant output
- progress and lifecycle events
- approval requests
- structured user-input requests if emitted
- tool execution starts and finishes
- errors
- completion and cancellation

The adapter must prefer Gemini structured output where available. Terminal-text parsing must be used only as a bounded fallback for cases where structured output is incomplete.

## Approval And Tool Experience

Gemini approval and tool actions must render through the same orchestration surfaces already used by other providers.

Implications:

- the adapter must expose approval requests through `respondToRequest`
- structured user-input prompts must flow through `respondToUserInput`
- tool execution must become standard provider runtime events, not raw terminal logs whenever a structured representation can be derived

The goal is UI consistency. A user should be able to switch between Codex, Claude, and Gemini without learning a separate interaction model inside T3 Code.

## Error Handling

### Probe-Time Errors

Probe-time errors must block or warn before session start:

- missing CLI
- broken CLI execution
- auth unavailable
- version too old
- invalid default model

### Runtime Errors

Runtime errors must be handled explicitly:

- child process exit
- interrupt failure
- resume failure
- event decode failure
- stuck approval flow

When possible, runtime errors must preserve enough session metadata for inspection and a later retry instead of deleting state immediately.

## Testing Strategy

### Unit Tests

Add focused unit coverage for:

- Gemini model catalog and label mapping
- model id normalization
- provider snapshot parsing
- auth and version probe parsing
- event normalization from Gemini structured stream fixtures

### Integration Tests

Add provider integration coverage for:

- explicit Gemini session start routing
- send turn on an active Gemini session
- interrupt propagation
- approval response forwarding
- stale session recovery from persisted resume state
- model selection persistence through recovery

### Platform Coverage

Windows deserves explicit smoke coverage because process spawning, path handling, and PTY behavior are historically more failure-prone there.

### Fixtures

Prefer recorded Gemini `stream-json` fixtures for parser and event normalization tests so refactors remain deterministic.

## Documentation Updates

Update repository docs that describe provider support so they stop claiming Codex-only behavior after Gemini support lands.

At minimum:

- `.docs/provider-architecture.md`
- `README.md`
- any provider setup or settings UI documentation that enumerates supported providers

## Rollout Plan

Implementation should land in slices:

1. contracts and provider catalogs
2. Gemini provider snapshot and model metadata
3. Gemini adapter and managed runtime
4. event normalization and approval flows
5. web model picker and provider status UI
6. integration tests and docs cleanup

This keeps breakage isolated and makes it easier to verify parity incrementally.

## Acceptance Criteria

- Gemini appears as a selectable built-in provider in T3 Code.
- Gemini provider status reports install and auth health using the installed local CLI.
- Users can start a Gemini-backed thread, send multiple turns, interrupt, and resume later.
- The model picker shows friendly names such as `Gemini 3 Pro Preview` while persisting exact model ids.
- Approvals and tool activity render in the standard thread UI.
- Provider recovery works through the existing `ProviderService` recovery path.
- Docs no longer describe the product as effectively Codex-only.
