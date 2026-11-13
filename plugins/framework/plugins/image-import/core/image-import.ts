import {
  readImageSize,
  type ImageSize,
} from "@plugins/packages/plugins/image-size/core";

/**
 * What an image import evaluates to: `import shot from "./x.png"` is
 * `{ src, width, height }`. The size is the file's own, read when the module
 * is built, so whoever draws it can give the box its size (`<img width
 * height>`, an aspect ratio) before a byte of the image arrives — no layout
 * shift when it lands. The ambient `*.png` / `*.jpg` / … declarations
 * (`web-core/web/image-imports.d.ts`) type every import as this.
 */
export interface ImportedImage {
  /** Where the image is fetched from: a served file, or a `data:` URL off the web build. */
  readonly src: string;
  /** Natural width, in pixels. */
  readonly width: number;
  /** Natural height, in pixels. */
  readonly height: number;
}

/**
 * The image types an import may name — exactly those whose size
 * `readImageSize` reads from the header — and the MIME type each is served as.
 * Any other image (`.svg`, `.avif`, `.ico`) is refused by `IMAGE_IMPORT_RE`'s
 * users rather than imported without a size.
 */
export const IMAGE_IMPORT_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** Image extensions with no size reader: an import of one fails loudly. */
const UNSIZED_IMAGE_EXTS = ["svg", "avif", "ico"];

/**
 * A module id naming an image file, query-free (`?raw`, `?url`, `?inline`
 * still mean what vite says). Matches the unsized types too, so a builder
 * catches them and throws instead of letting them fall through to an inline
 * `data:` string.
 */
export const IMAGE_IMPORT_RE = new RegExp(
  `\\.(${[...Object.keys(IMAGE_IMPORT_MIME), ...UNSIZED_IMAGE_EXTS].join("|")})$`,
  "i",
);

function extOf(file: string): string {
  return file.slice(file.lastIndexOf(".") + 1).toLowerCase();
}

/** The pixel size of an imported image file; throws naming the file when unreadable. */
export function importedImageSize(file: string, bytes: Uint8Array): ImageSize {
  if (IMAGE_IMPORT_MIME[extOf(file)] === undefined) {
    throw new Error(
      `[image-import] ${file}: an imported image must be one of ` +
        `${Object.keys(IMAGE_IMPORT_MIME).join(", ")} — its size is read from ` +
        `its header so the page can reserve its box. Import a vector with ` +
        `\`?raw\` and draw it inline instead.`,
    );
  }
  const read = readImageSize(bytes);
  if (read.kind !== "size") {
    throw new Error(
      `[image-import] ${file}: no pixel size in its header (${read.kind})`,
    );
  }
  return read.size;
}

/** `bytes` as a `data:` URL of the file's image type. */
export function imageDataUrl(file: string, bytes: Uint8Array): string {
  const mime = IMAGE_IMPORT_MIME[extOf(file)];
  if (mime === undefined) {
    throw new Error(`[image-import] no image type for ${file}`);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * The module an image import loads: its default export the `ImportedImage`,
 * `srcExpression` a JS expression for the URL (a string literal, or a
 * bundler's file-URL placeholder).
 */
export function imageModuleCode(
  srcExpression: string,
  size: ImageSize,
): string {
  return (
    `export default Object.freeze({ src: ${srcExpression}, ` +
    `width: ${size.width}, height: ${size.height} });\n`
  );
}
