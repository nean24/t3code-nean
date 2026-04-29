import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModelPickerSidebar } from "./ModelPickerSidebar";

function makeProvider(provider: ProviderKind, status: ServerProvider["status"]): ServerProvider {
  return {
    provider,
    installed: true,
    enabled: true,
    version: null,
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-04-29T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ModelPickerSidebar", () => {
  it("renders Gemini as a normal provider tab when Gemini is ready", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerSidebar
        selectedProvider="favorites"
        onSelectProvider={() => {}}
        providers={[makeProvider("gemini", "ready")]}
      />,
    );

    expect(markup).toContain('data-model-picker-provider="gemini"');
    expect(markup).not.toContain('data-model-picker-provider="gemini-coming-soon"');
    expect(markup).not.toContain("Gemini — Coming soon");
  });

  it("keeps GitHub Copilot as a disabled coming-soon provider", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerSidebar
        selectedProvider="favorites"
        onSelectProvider={() => {}}
        providers={[makeProvider("gemini", "ready")]}
      />,
    );

    expect(markup).toContain('data-model-picker-provider="github-copilot-coming-soon"');
    expect(markup).toContain("Github Copilot");
  });
});
