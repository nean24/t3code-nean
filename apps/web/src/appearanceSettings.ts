import type { AppFontPreset, ClientSettings } from "@t3tools/contracts/settings";

export const DEFAULT_APP_FONT_STACK =
  '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

const FONT_STACK_BY_PRESET = {
  default: DEFAULT_APP_FONT_STACK,
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  inter: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  "jetbrains-mono": '"JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  "sf-mono": '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
} as const satisfies Record<Exclude<AppFontPreset, "custom">, string>;

export type AppearanceFontInput = {
  preset: AppFontPreset;
  customStack: string;
};

export type AppearanceCssVariables = Record<
  | "--app-font-family"
  | "--app-background-image"
  | "--app-background-opacity"
  | "--app-background-blur",
  string
>;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function formatCssNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function cssUrl(value: string): string {
  return `url("${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`;
}

export function resolveAppFontStack(input: AppearanceFontInput): string {
  if (input.preset === "custom") {
    return input.customStack.trim() || DEFAULT_APP_FONT_STACK;
  }
  return FONT_STACK_BY_PRESET[input.preset] ?? DEFAULT_APP_FONT_STACK;
}

export function resolveAppearanceCssVariables(
  settings: Pick<
    ClientSettings,
    | "appFontPreset"
    | "appFontCustomStack"
    | "backgroundImage"
    | "backgroundOpacity"
    | "backgroundBlur"
  >,
): AppearanceCssVariables {
  const backgroundImage = settings.backgroundImage.trim();
  const backgroundOpacity = clampNumber(settings.backgroundOpacity, 0, 0.6);
  const backgroundBlur = clampNumber(settings.backgroundBlur, 0, 24);

  return {
    "--app-font-family": resolveAppFontStack({
      preset: settings.appFontPreset,
      customStack: settings.appFontCustomStack,
    }),
    "--app-background-image": backgroundImage ? cssUrl(backgroundImage) : "none",
    "--app-background-opacity": formatCssNumber(backgroundOpacity),
    "--app-background-blur": `${formatCssNumber(backgroundBlur)}px`,
  };
}
