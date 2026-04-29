import { useEffect, useMemo } from "react";

import { resolveAppearanceCssVariables } from "../appearanceSettings";
import { syncBrowserChromeTheme } from "./useTheme";
import { useSettings } from "./useSettings";

const APPEARANCE_CSS_VARIABLES = [
  "--app-font-family",
  "--app-background-image",
  "--app-background-opacity",
  "--app-background-blur",
] as const;

export function useAppearanceSettings() {
  const appearanceSettings = useSettings((settings) => ({
    appFontPreset: settings.appFontPreset,
    appFontCustomStack: settings.appFontCustomStack,
    backgroundImage: settings.backgroundImage,
    backgroundOpacity: settings.backgroundOpacity,
    backgroundBlur: settings.backgroundBlur,
  }));

  const cssVariables = useMemo(
    () => resolveAppearanceCssVariables(appearanceSettings),
    [appearanceSettings],
  );

  useEffect(() => {
    const root = document.documentElement;
    for (const [property, value] of Object.entries(cssVariables)) {
      root.style.setProperty(property, value);
    }
    syncBrowserChromeTheme();

    return () => {
      for (const property of APPEARANCE_CSS_VARIABLES) {
        root.style.removeProperty(property);
      }
      syncBrowserChromeTheme();
    };
  }, [cssVariables]);
}
