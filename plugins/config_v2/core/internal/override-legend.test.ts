import { describe, expect, test } from "bun:test";
import { withOverrideLegend } from "./override-legend";

const HEAD =
  "// @legend — how to write this file (rewritten by ./equin build; edits inside this block are lost):";

describe("withOverrideLegend", () => {
  test("inserts the block under the hash line", () => {
    const out = withOverrideLegend('// @hash abc123\n{\n  "items": []\n}\n', [
      "A",
      "B",
    ]);
    expect(out).toBe(
      `// @hash abc123\n${HEAD}\n//   A\n//   B\n{\n  "items": []\n}\n`,
    );
  });

  test("is idempotent", () => {
    const once = withOverrideLegend("// @hash abc\n{}\n", ["A"]);
    expect(withOverrideLegend(once, ["A"])).toBe(once);
  });

  test("replaces a stale block and keeps the author's own comments", () => {
    const text = `// @hash abc\n${HEAD}\n//   old\n// @review — check\n// guidance\n{\n  // mine\n}\n`;
    expect(withOverrideLegend(text, ["new"])).toBe(
      `// @hash abc\n${HEAD}\n//   new\n// @review — check\n// guidance\n{\n  // mine\n}\n`,
    );
  });

  test("moves a block that ended up below a review marker back under the hash", () => {
    const text = `// @hash abc\n// @review — check\n${HEAD}\n//   A\n{}\n`;
    expect(withOverrideLegend(text, ["A"])).toBe(
      `// @hash abc\n${HEAD}\n//   A\n// @review — check\n{}\n`,
    );
  });

  test("never touches a legend-looking comment inside the body", () => {
    const text = `// @hash abc\n{\n// @legend inside\n}\n`;
    expect(withOverrideLegend(text, [])).toBe(text);
  });

  test("an empty legend removes the block", () => {
    const text = `// @hash abc\n${HEAD}\n//   A\n{}\n`;
    expect(withOverrideLegend(text, [])).toBe("// @hash abc\n{}\n");
  });

  test("throws on a hashless file", () => {
    expect(() => withOverrideLegend("{}\n", ["A"])).toThrow();
  });
});
