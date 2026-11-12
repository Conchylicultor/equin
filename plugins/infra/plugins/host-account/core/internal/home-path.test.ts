import { describe, expect, test } from "bun:test";
import { absolutePath, displayPath, tildifyText } from "./home-path";

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

  test("a home at the root: every path is under it", () => {
    expect(absolutePath("~/Documents", "/")).toBe("/Documents");
    expect(absolutePath("~", "/")).toBe("/");
    expect(displayPath("/Documents/a.md", "/")).toBe("~/Documents/a.md");
    expect(displayPath("/", "/")).toBe("~");
    expect(displayPath("~/a", "/")).toBe("~/a");
    expect(displayPath("relative", "/")).toBe("relative");
  });
});

describe("tildifyText", () => {
  test("collapses the home directory wherever a path segment starts with it", () => {
    expect(tildifyText("wrote /h/me/notes/a.html and /h/me", HOME_ABS)).toBe(
      "wrote ~/notes/a.html and ~",
    );
    expect(
      tildifyText("cd /h/me; ls /h/meow /h/me-x /other/h/me", HOME_ABS),
    ).toBe("cd ~; ls /h/meow /h/me-x /other/h/me");
  });
});
