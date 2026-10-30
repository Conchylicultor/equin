import { describe, expect, test } from "bun:test";
import { isFileInput, urlAssetRefs } from "./package-assets";

describe("isFileInput", () => {
  test("a relative or absolute path is a file", () => {
    expect(isFileInput("node_modules/.bun/a@1/node_modules/a/index.js")).toBe(
      true,
    );
    expect(isFileInput("../../node_modules/a/index.js")).toBe(true);
    expect(isFileInput("/abs/node_modules/a/index.js")).toBe(true);
  });

  test("a module a browser field disables is not", () => {
    expect(
      isFileInput(
        "(disabled):node_modules/.bun/util@0.12.5/node_modules/util/util.js",
      ),
    ).toBe(false);
  });
});

describe("urlAssetRefs", () => {
  test("collects relative non-code URL refs", () => {
    const src = `new URL("./a.wasm", import.meta.url); new URL("./b.js", import.meta.url)`;
    expect(urlAssetRefs(src)).toEqual(["./a.wasm"]);
  });
});
