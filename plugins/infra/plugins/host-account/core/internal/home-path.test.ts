import { describe, expect, test } from "bun:test";
import { absolutePath, displayPath } from "./home-path";

const HOME_ABS = "/h/me";

describe("home-relative paths", () => {
  test("tilde expansion and collapse round-trip", () => {
    expect(absolutePath("~/a", HOME_ABS)).toBe("/h/me/a");
    expect(absolutePath("~", HOME_ABS)).toBe(HOME_ABS);
    expect(displayPath("/h/me/a", HOME_ABS)).toBe("~/a");
    expect(displayPath("/h/me", HOME_ABS)).toBe("~");
    expect(displayPath("/h/meow", HOME_ABS)).toBe("/h/meow");
    expect(displayPath("~/a", HOME_ABS)).toBe("~/a");
  });
});
