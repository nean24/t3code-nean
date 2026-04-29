import { describe, expect, it } from "vitest";

import {
  createBackgroundImageUploadPatch,
  validateBackgroundImageFile,
} from "./backgroundImageUpload";

describe("backgroundImageUpload", () => {
  it("accepts supported image files", () => {
    expect(
      validateBackgroundImageFile({
        name: "background.png",
        size: 128_000,
        type: "image/png",
      }),
    ).toEqual({ ok: true });
  });

  it("uses the filename extension only when the browser omits the MIME type", () => {
    expect(
      validateBackgroundImageFile({
        name: "background.webp",
        size: 128_000,
        type: "",
      }),
    ).toEqual({ ok: true });

    expect(
      validateBackgroundImageFile({
        name: "background.png",
        size: 128_000,
        type: "text/plain",
      }),
    ).toEqual({
      ok: false,
      message: "Choose a PNG, JPG, WEBP, GIF, or AVIF image.",
    });
  });

  it("rejects unsupported or oversized files", () => {
    expect(
      validateBackgroundImageFile({
        name: "background.txt",
        size: 128_000,
        type: "text/plain",
      }),
    ).toEqual({
      ok: false,
      message: "Choose a PNG, JPG, WEBP, GIF, or AVIF image.",
    });

    expect(
      validateBackgroundImageFile({
        name: "background.png",
        size: 6 * 1024 * 1024,
        type: "image/png",
      }),
    ).toEqual({
      ok: false,
      message: "Choose an image smaller than 5 MB.",
    });
  });

  it("stores the uploaded image and makes a new background visible", () => {
    expect(createBackgroundImageUploadPatch("data:image/png;base64,abc", 0)).toEqual({
      backgroundImage: "data:image/png;base64,abc",
      backgroundOpacity: 0.25,
    });

    expect(createBackgroundImageUploadPatch("data:image/png;base64,abc", 0.4)).toEqual({
      backgroundImage: "data:image/png;base64,abc",
    });
  });
});
