import { describe, expect, it } from "bun:test";
import { scopeDeclarationError } from "./scope-declaration";

const rules = { a: {}, b: {} };

describe("scopeDeclarationError", () => {
  it("accepts a declaration naming only defined rules", () => {
    expect(
      scopeDeclarationError(
        { closed: ["a"], noDebt: ["b"], outOfScope: { a: ["test"] } },
        rules,
      ),
    ).toBeNull();
  });

  it("refuses a noDebt rule the barrel does not define", () => {
    expect(scopeDeclarationError({ noDebt: ["typo"] }, rules)).toContain(
      'noDebt "typo"',
    );
  });

  it("refuses a rule both closed and noDebt", () => {
    expect(
      scopeDeclarationError({ closed: ["a"], noDebt: ["a"] }, rules),
    ).toContain("both closed and noDebt");
  });

  it("refuses an unknown file category", () => {
    expect(
      scopeDeclarationError(
        { outOfScope: { a: ["nope" as unknown as "test"] } },
        rules,
      ),
    ).toContain("unknown file categories");
  });
});
