import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_FONT_STACK,
  resolveAppearanceCssVariables,
  resolveAppFontStack,
} from "./appearanceSettings";

describe("appearanceSettings", () => {
  it("resolves preset font stacks", () => {
    expect(resolveAppFontStack({ preset: "default", customStack: "" })).toBe(
      DEFAULT_APP_FONT_STACK,
    );
    expect(resolveAppFontStack({ preset: "system", customStack: "" })).toBe(
      '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    );
    expect(resolveAppFontStack({ preset: "jetbrains-mono", customStack: "" })).toContain(
      "JetBrains Mono",
    );
  });

  it("uses the custom font stack only when it has content", () => {
    expect(
      resolveAppFontStack({
        preset: "custom",
        customStack: '"Inter", ui-sans-serif, system-ui, sans-serif',
      }),
    ).toBe('"Inter", ui-sans-serif, system-ui, sans-serif');

    expect(resolveAppFontStack({ preset: "custom", customStack: "   " })).toBe(
      DEFAULT_APP_FONT_STACK,
    );
  });

  it("clamps numeric background values and clears empty images", () => {
    const variables = resolveAppearanceCssVariables({
      appFontPreset: "default",
      appFontCustomStack: "",
      backgroundImage: "   ",
      backgroundOpacity: 4,
      backgroundBlur: -2,
    });

    expect(variables["--app-background-image"]).toBe("none");
    expect(variables["--app-background-opacity"]).toBe("0.6");
    expect(variables["--app-background-blur"]).toBe("0px");
  });

  it("renders uploaded background images as CSS url values", () => {
    const variables = resolveAppearanceCssVariables({
      appFontPreset: "custom",
      appFontCustomStack: "Inter, sans-serif",
      backgroundImage: "data:image/png;base64,abc",
      backgroundOpacity: 0.25,
      backgroundBlur: 12,
    });

    expect(variables["--app-font-family"]).toBe("Inter, sans-serif");
    expect(variables["--app-background-image"]).toBe('url("data:image/png;base64,abc")');
    expect(variables["--app-background-opacity"]).toBe("0.25");
    expect(variables["--app-background-blur"]).toBe("12px");
  });
});
