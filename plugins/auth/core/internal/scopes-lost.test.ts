import { describe, expect, test } from "bun:test";
import { lostScopes, scopeLabel } from "./scopes-lost";

describe("lostScopes", () => {
  test("held scopes missing from the grant, in held order, deduped", () => {
    expect(
      lostScopes(
        ["openid", "https://www.googleapis.com/auth/drive.file", "x", "x"],
        ["openid"],
      ),
    ).toEqual(["https://www.googleapis.com/auth/drive.file", "x"]);
  });
  test("a wider grant loses nothing", () => {
    expect(lostScopes(["a"], ["a", "b"])).toEqual([]);
  });
});

test("scopeLabel reads a URL scope by its last segment", () => {
  expect(scopeLabel("https://www.googleapis.com/auth/drive.file")).toBe(
    "drive.file",
  );
  expect(scopeLabel("openid")).toBe("openid");
});
