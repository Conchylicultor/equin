import { describe, expect, it } from "bun:test";
import { symbolBody } from "./resolve-icon";

describe("symbolBody", () => {
  it("reads a glyph from the installed set in the default style", () => {
    const { body, width, height } = symbolBody("home");
    expect(body).toContain("<path");
    expect([width, height]).toEqual([24, 24]);
  });
});
