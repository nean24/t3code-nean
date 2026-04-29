import { Schema } from "effect";
import { assert, it } from "@effect/vitest";

import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

it("decodes appearance customization defaults for older client settings", () => {
  const settings = Schema.decodeSync(ClientSettingsSchema)({});

  assert.strictEqual(settings.appFontPreset, "default");
  assert.strictEqual(settings.appFontCustomStack, "");
  assert.strictEqual(settings.backgroundImage, "");
  assert.strictEqual(settings.backgroundOpacity, 0);
  assert.strictEqual(settings.backgroundBlur, 0);
});

it("decodes explicit appearance customization settings", () => {
  const settings = Schema.decodeSync(ClientSettingsSchema)({
    appFontPreset: "custom",
    appFontCustomStack: '"Inter", ui-sans-serif, system-ui, sans-serif',
    backgroundImage: "data:image/png;base64,abc",
    backgroundOpacity: 0.35,
    backgroundBlur: 8,
  });

  assert.strictEqual(settings.appFontPreset, "custom");
  assert.strictEqual(settings.appFontCustomStack, '"Inter", ui-sans-serif, system-ui, sans-serif');
  assert.strictEqual(settings.backgroundImage, "data:image/png;base64,abc");
  assert.strictEqual(settings.backgroundOpacity, 0.35);
  assert.strictEqual(settings.backgroundBlur, 8);
});

it("accepts appearance customization client setting patches", () => {
  const patch = Schema.decodeSync(ClientSettingsPatch)({
    appFontPreset: "system",
    appFontCustomStack: "",
    backgroundImage: "data:image/webp;base64,abc",
    backgroundOpacity: 0.2,
    backgroundBlur: 4,
  });

  assert.strictEqual(patch.appFontPreset, "system");
  assert.strictEqual(patch.backgroundImage, "data:image/webp;base64,abc");
});
