import type { ClientSettingsPatch } from "@t3tools/contracts/settings";

export const BACKGROUND_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";
export const MAX_BACKGROUND_IMAGE_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_UPLOADED_BACKGROUND_OPACITY = 0.25;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const SUPPORTED_IMAGE_EXTENSIONS = /\.(avif|gif|jpe?g|png|webp)$/i;

type BackgroundImageFileLike = Pick<File, "name" | "size" | "type">;

export type BackgroundImageFileValidation =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    };

export function validateBackgroundImageFile(
  file: BackgroundImageFileLike,
): BackgroundImageFileValidation {
  const hasSupportedType = file.type
    ? SUPPORTED_IMAGE_TYPES.has(file.type)
    : SUPPORTED_IMAGE_EXTENSIONS.test(file.name);

  if (!hasSupportedType) {
    return {
      ok: false,
      message: "Choose a PNG, JPG, WEBP, GIF, or AVIF image.",
    };
  }

  if (file.size > MAX_BACKGROUND_IMAGE_FILE_BYTES) {
    return {
      ok: false,
      message: "Choose an image smaller than 5 MB.",
    };
  }

  return { ok: true };
}

export function createBackgroundImageUploadPatch(
  dataUrl: string,
  currentOpacity: number,
): ClientSettingsPatch {
  return {
    backgroundImage: dataUrl,
    ...(currentOpacity > 0 ? {} : { backgroundOpacity: DEFAULT_UPLOADED_BACKGROUND_OPACITY }),
  };
}

export function readBackgroundImageFile(file: File): Promise<string> {
  const validation = validateBackgroundImageFile(file);
  if (!validation.ok) {
    return Promise.reject(new Error(validation.message));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
        return;
      }
      reject(new Error("Could not read background image."));
    });
    reader.addEventListener("error", () => {
      reject(new Error("Could not read background image."));
    });
    reader.readAsDataURL(file);
  });
}
