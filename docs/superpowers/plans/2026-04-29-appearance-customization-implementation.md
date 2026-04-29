# Appearance Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local customizable app font/background controls and fix Gemini being shown as a stale disabled "Coming soon" model-picker tab.

**Architecture:** Appearance preferences are client-only settings decoded by `packages/contracts`, resolved by pure web helpers, applied through CSS variables, and edited in `Settings > General`. Gemini should use the same provider-option and live-status path as other real providers.

**Tech Stack:** React, Vite, Tailwind CSS, Effect Schema, Vitest, Bun.

---

## File Map

- Modify `packages/contracts/src/settings.ts`: add client settings fields, defaults, and patch fields.
- Add `packages/contracts/src/settings.test.ts`: verify settings defaults and appearance value decoding.
- Add `apps/web/src/appearanceSettings.ts`: pure font/background resolver and clamp helpers.
- Add `apps/web/src/backgroundImageUpload.ts`: upload validation, data URL reading, and visible-default patch helper.
- Add `apps/web/src/appearanceSettings.test.ts`: red-green tests for appearance resolver behavior.
- Add `apps/web/src/hooks/useAppearanceSettings.ts`: apply resolved settings to CSS variables.
- Modify `apps/web/src/main.tsx`: mount the appearance settings bridge.
- Modify `apps/web/src/index.css`: read app font/background CSS variables.
- Modify `apps/web/src/components/settings/SettingsPanels.tsx`: add Appearance rows and reset labels.
- Modify `apps/web/src/session-logic.ts`: add Gemini as an available provider option.
- Modify `apps/web/src/components/chat/ModelPickerSidebar.tsx`: remove hard-coded disabled Gemini block.
- Modify or add tests around `ModelPickerSidebar`: assert Gemini ready provider is selectable and no `gemini-coming-soon` control renders.

### Task 1: Contract Settings Schema

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Add: `packages/contracts/src/settings.test.ts`

- [ ] **Step 1: Write failing settings tests**

Create `packages/contracts/src/settings.test.ts` with tests that decode `{}` and assert appearance defaults, then decode explicit appearance values and assert they survive.

- [ ] **Step 2: Run red test**

Run: `bun run test packages/contracts/src/settings.test.ts`
Expected: fail because fields like `appFontPreset` do not exist.

- [ ] **Step 3: Add schema fields and patch fields**

Add `AppFontPreset`, defaults, client settings fields, and `ClientSettingsPatch` entries.

- [ ] **Step 4: Run green test**

Run: `bun run test packages/contracts/src/settings.test.ts`
Expected: pass.

### Task 2: Appearance Resolver

**Files:**

- Add: `apps/web/src/appearanceSettings.ts`
- Add: `apps/web/src/appearanceSettings.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Cover preset font resolution, custom font fallback, opacity/blur clamps, empty background, and uploaded data URL background CSS value generation.

- [ ] **Step 2: Run red test**

Run: `bun run test apps/web/src/appearanceSettings.test.ts`
Expected: fail because `appearanceSettings.ts` does not exist.

- [ ] **Step 3: Implement resolver**

Implement pure helpers for resolving font stack, clamping numbers, and generating CSS custom property values.

- [ ] **Step 4: Run green test**

Run: `bun run test apps/web/src/appearanceSettings.test.ts`
Expected: pass.

### Task 3: Apply Appearance to the App

**Files:**

- Add: `apps/web/src/hooks/useAppearanceSettings.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/index.css`

- [ ] **Step 1: Add hook**

Read appearance settings through `useSettings`, resolve CSS values with `appearanceSettings.ts`, and set/remove CSS variables on `document.documentElement`.

- [ ] **Step 2: Mount hook**

Add a small `AppearanceSettingsBridge` component in `main.tsx` near existing app providers so the hook runs once for the app.

- [ ] **Step 3: Update CSS**

Use `--app-font-family` in `body`. Add a fixed `body::before` background-image layer using `--app-background-image`, `--app-background-opacity`, and `--app-background-blur`; keep existing `body::after` noise above it.

### Task 4: Settings UI

**Files:**

- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`

- [ ] **Step 1: Add controls**

Add an Appearance section under Theme with font preset select, custom font input, background image upload with clear action, and opacity/blur numeric range controls. The upload control should accept common raster image files, store a FileReader data URL in client settings, reject files larger than 5 MB, and set background strength to a visible default when the current strength is `0`.

- [ ] **Step 2: Add reset labels**

Include changed appearance labels in `useSettingsRestore` and add row-level resets matching existing settings patterns.

### Task 5: Gemini Model Picker Rail

**Files:**

- Modify: `apps/web/src/session-logic.ts`
- Modify: `apps/web/src/components/chat/ModelPickerSidebar.tsx`
- Test: existing or new `apps/web/src/components/chat/ModelPickerSidebar.test.tsx`

- [ ] **Step 1: Write failing sidebar tests**

Assert a ready Gemini provider renders a normal `data-model-picker-provider="gemini"` button and does not render `data-model-picker-provider="gemini-coming-soon"`. Assert GitHub Copilot coming soon remains.

- [ ] **Step 2: Run red test**

Run: `bun run test apps/web/src/components/chat/ModelPickerSidebar.test.tsx`
Expected: fail because Gemini is not in available provider options and stale coming-soon control exists.

- [ ] **Step 3: Implement rail fix**

Add Gemini to `PROVIDER_OPTIONS` with `available: true`, remove the hard-coded Gemini coming-soon block, keep GitHub Copilot coming-soon block.

- [ ] **Step 4: Run green test**

Run: `bun run test apps/web/src/components/chat/ModelPickerSidebar.test.tsx`
Expected: pass.

### Task 6: Final Verification

**Files:** all changed files

- [ ] **Step 1: Format**

Run: `bun fmt`
Expected: exit 0.

- [ ] **Step 2: Lint**

Run: `bun lint`
Expected: exit 0. Existing warnings may remain, but no new errors.

- [ ] **Step 3: Typecheck**

Run: `bun typecheck` with a long timeout.
Expected: exit 0.

- [ ] **Step 4: Targeted tests**

Run: `bun run test packages/contracts/src/settings.test.ts apps/web/src/appearanceSettings.test.ts apps/web/src/components/chat/ModelPickerSidebar.test.tsx`
Expected: exit 0.
