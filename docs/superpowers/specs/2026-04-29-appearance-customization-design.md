# Appearance Customization Design

## Summary

Add user-customizable app typography and background image controls to T3 Code. This is a client-only appearance feature: it affects the local web/desktop UI, does not change provider sessions, and does not require server protocol changes.

The initial scope is "custom enough": preset font choices, a custom font-stack input, a background image URL/path input, and controls for background opacity and blur.

## Goals

- Let users personalize the app font without editing CSS.
- Let users set a background image while preserving readability.
- Remove the stale Gemini "Coming soon" model-picker tab so Gemini is selectable wherever Gemini models are already available.
- Persist choices across reloads and desktop restarts.
- Keep the implementation predictable under reconnects, settings hydration, and invalid persisted values.
- Avoid server-side scope unless a future sync requirement appears.

## Non-Goals

- No full theme editor.
- No import/export theme format.
- No custom font file upload in this pass.
- No image upload or file picker bridge API in this pass.
- No provider/session-level configuration changes.

## Recommended Approach

Use client settings plus CSS variables.

`packages/contracts` remains schema-only. It gains client-setting fields and defaults so older persisted settings decode cleanly. `apps/web` applies those settings at the document level through a small appearance hook and CSS variables.

This keeps appearance local to the app shell, avoids unnecessary RPC/server persistence, and follows the existing split where personal UI preferences live in client settings.

## Settings Model

Add these client settings:

- `appFontPreset`: one of `default`, `system`, `inter`, `jetbrains-mono`, `sf-mono`, `custom`.
- `appFontCustomStack`: trimmed string, default empty.
- `backgroundImage`: trimmed string, default empty.
- `backgroundOpacity`: bounded number from `0` to `0.6`, default `0`.
- `backgroundBlur`: bounded number from `0` to `24`, default `0`.

Patch support mirrors the existing `ClientSettingsPatch` shape.

Invalid or missing persisted values must fall back to defaults through Effect Schema decoding. The UI can clamp slider values before update, but decoding should still be robust if storage is edited manually.

## Runtime Application

Add a focused web runtime module or hook, tentatively `apps/web/src/hooks/useAppearanceSettings.ts`.

Responsibilities:

- Read appearance settings through `useSettings`.
- Resolve the effective font stack from preset plus custom input.
- Normalize background image into a safe CSS value.
- Apply CSS variables to `document.documentElement`.
- Remove or reset variables when settings return to defaults.

CSS variables:

- `--app-font-family`
- `--app-background-image`
- `--app-background-opacity`
- `--app-background-blur`

`apps/web/src/index.css` should use `--app-font-family` for `body` and render the background image in a fixed pseudo-layer behind the app. The existing subtle noise overlay can remain above the image, but the image layer must not interfere with pointer events, scrolling, or browser chrome color syncing.

## UI

Add an `Appearance` subsection inside `Settings > General`, near the existing `Theme` row.

Rows:

- `App font`: select preset.
- `Font stack`: text input shown only when `App font` is `Custom`.
- `Background image`: text input for URL/path plus a clear action.
- `Background strength`: slider or compact numeric control for opacity.
- `Background blur`: slider or compact numeric control for blur.

Each changed value gets a reset action consistent with existing settings rows. The global restore-defaults path includes these appearance labels.

The background input starts as URL/path text instead of upload because the current local API exposes folder picking, confirmation, editor opening, external links, context menus, and persistence, but not an image file picker. A later desktop bridge can add true file selection without changing the settings model.

Also fix the model picker provider rail while touching the settings/model-picker area:

- Remove the hard-coded disabled Gemini "Coming soon" rail button from `apps/web/src/components/chat/ModelPickerSidebar.tsx`.
- Add Gemini to the available provider option source used by `AVAILABLE_PROVIDER_OPTIONS`, or otherwise ensure the sidebar derives Gemini from the same provider capability data as the rest of the picker.
- Preserve the GitHub Copilot "Coming soon" button until Copilot has real provider support.
- Gemini should be disabled only when the live provider status is missing or not `ready`, using the existing `describeUnavailableProvider` path. It should not be blocked by a static coming-soon entry once server/provider status reports Gemini as ready.
- Search/favorites behavior should remain unchanged: Gemini models that already appear in favorites/search should continue to appear, and the Gemini provider tab should filter to Gemini models when selected.

## Readability and Failure Handling

- Empty background image means no image layer.
- Invalid URLs or inaccessible local paths should fail visually without crashing.
- Opacity defaults to `0`, so simply entering a background path does not unexpectedly reduce contrast until the user increases strength.
- Blur defaults to `0` and is capped to prevent expensive or unreadable rendering.
- Font custom stack falls back to the default app font when blank.
- CSS variable updates should be transition-safe and cheap; no React tree-wide re-render strategy is needed beyond settings subscription.

## Accessibility and Performance

- Keep controls keyboard accessible with visible labels and existing UI primitives.
- Preserve foreground/background contrast by applying image opacity behind the normal app surfaces rather than directly replacing `--background`.
- Avoid loading or pre-processing images in JavaScript.
- Avoid large inline data blobs in settings; users can paste URLs or paths, but the app should not encode files into storage.

## Testing

Add focused tests where logic is pure:

- Settings schema decodes defaults for older documents.
- Appearance resolver maps presets and custom stack correctly.
- Numeric values are clamped or decoded to safe defaults.
- Background CSS value normalization handles empty strings and ordinary URL/path values.
- Model picker sidebar exposes Gemini as a normal provider tab when Gemini provider status is `ready`.
- Model picker sidebar no longer renders a disabled `gemini-coming-soon` control.
- GitHub Copilot still renders as a disabled coming-soon control.

Implementation completion requires:

- `bun fmt`
- `bun lint`
- `bun typecheck`

Do not run `bun test`; use `bun run test` only if targeted tests are needed.

## Implementation Notes

- Keep `packages/contracts` schema-only.
- Prefer a small shared appearance helper in `apps/web/src` over duplicating font/background normalization in components and hooks.
- Use existing `SettingsRow`, `SettingsSection`, `Input`, `Select`, and reset button patterns.
- If a slider primitive is not available, use a constrained numeric input or range input styled consistently with the existing settings controls.
