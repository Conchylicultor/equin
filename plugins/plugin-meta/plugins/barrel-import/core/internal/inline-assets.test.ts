import { describe, expect, test } from "bun:test";
import { assetDataUrl } from "./inline-assets";

describe("assetDataUrl", () => {
  test("a jpeg as vite's library build inlines it", () => {
    expect(assetDataUrl("JPG", new Uint8Array([0xff, 0xd8, 0xff]))).toBe(
      "data:image/jpeg;base64,/9j/",
    );
  });
  test("an unknown type throws", () => {
    expect(() => assetDataUrl("xyz", new Uint8Array())).toThrow(".xyz");
  });
});
