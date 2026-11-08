import { describe, expect, it } from "bun:test";
import { symbolBody } from "./resolve-icon";

describe("symbolBody", () => {
  it("reads a glyph from the installed set in the default style", async () => {
    const { body, width, height } = await symbolBody("home");
    expect(body).toContain("<path");
    expect([width, height]).toEqual([24, 24]);
  });
});
