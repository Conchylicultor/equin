import { describe, expect, test } from "bun:test";
import {
  IMAGE_IMPORT_RE,
  imageDataUrl,
  imageModuleCode,
  importedImageSize,
} from "./image-import";

// A 3×2 PNG header: signature, IHDR length + type, width, height.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0,
]);

describe("image-import", () => {
  test("reads the size an import reserves", () => {
    expect(importedImageSize("/a/x.PNG", PNG)).toEqual({ width: 3, height: 2 });
  });

  test("refuses an image it cannot size", () => {
    expect(IMAGE_IMPORT_RE.test("/a/x.svg")).toBe(true);
    expect(() => importedImageSize("/a/x.svg", PNG)).toThrow("x.svg");
    expect(() => importedImageSize("/a/x.jpg", new Uint8Array(4))).toThrow(
      "x.jpg",
    );
  });

  test("a query is not an image import", () => {
    expect(IMAGE_IMPORT_RE.test("/a/x.png?raw")).toBe(false);
  });

  test("data: URL of the file's type", () => {
    expect(imageDataUrl("x.jpg", new Uint8Array([0xff, 0xd8, 0xff]))).toBe(
      "data:image/jpeg;base64,/9j/",
    );
  });

  test("module code exports the image", () => {
    expect(imageModuleCode(`"u"`, { width: 3, height: 2 })).toBe(
      `export default Object.freeze({ src: "u", width: 3, height: 2 });\n`,
    );
  });
});
