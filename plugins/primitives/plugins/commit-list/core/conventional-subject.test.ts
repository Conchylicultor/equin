import { describe, expect, test } from "bun:test";
import { parseConventionalSubject } from "./conventional-subject";

describe("parseConventionalSubject", () => {
  test("type only", () => {
    expect(parseConventionalSubject("feat: add a thing")).toEqual({
      type: "feat",
      scopes: [],
      breaking: false,
      description: "add a thing",
    });
  });

  test("scopes, split and trimmed", () => {
    expect(
      parseConventionalSubject(
        "fix(principal, gateway): nothing public is the owner",
      ),
    ).toEqual({
      type: "fix",
      scopes: ["principal", "gateway"],
      breaking: false,
      description: "nothing public is the owner",
    });
  });

  test("nested scope paths and breaking marker", () => {
    expect(
      parseConventionalSubject("refactor(website/layers)!: drop x"),
    ).toEqual({
      type: "refactor",
      scopes: ["website/layers"],
      breaking: true,
      description: "drop x",
    });
  });

  test("type is lowercased", () => {
    expect(parseConventionalSubject("Fix: y").type).toBe("fix");
  });

  test.each([
    "Merge branch 'main' into x",
    'Revert "feat: x"',
    "plain subject",
    "fix:no space",
    "fix(): ",
  ])("not conventional: %s", (subject) => {
    expect(parseConventionalSubject(subject)).toEqual({
      type: null,
      scopes: [],
      breaking: false,
      description: subject,
    });
  });

  test("empty scope parens are no scopes", () => {
    expect(parseConventionalSubject("chore(): tidy").scopes).toEqual([]);
  });
});
