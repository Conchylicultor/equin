import { describe, expect, test } from "bun:test";
import { LEGACY_IDS } from "../core/internal/legacy-ids";
import { offendingLine } from "./legacy-id";

// The old name, assembled so this file does not itself spell it.
const OLD = ["sing", "ularity"].join("");

describe("offendingLine", () => {
  test("flags the old name in any case: identifiers, scopes, keys, prose", () => {
    expect(offendingLine(`const ns = "${OLD}";`, [])).toBe(true);
    expect(
      offendingLine(
        `function is${OLD[0]!.toUpperCase()}${OLD.slice(1)}() {}`,
        [],
      ),
    ).toBe(true);
    expect(offendingLine(`"name": "@${OLD}/plugin-a"`, [])).toBe(true);
    expect(offendingLine(`// the ${OLD} data root`, [])).toBe(true);
  });

  test("leaves the env vars, the data dir and repo URLs to their own steps", () => {
    expect(offendingLine(`process.env.${OLD.toUpperCase()}_DIR`, [])).toBe(
      false,
    );
    expect(offendingLine(`~/.${OLD}/worktrees/x`, [])).toBe(false);
    expect(offendingLine(`"$HOME/.${OLD}"`, [])).toBe(false);
    expect(offendingLine(`https://github.com/Owner/${OLD}/pull/1`, [])).toBe(
      false,
    );
  });

  test("a data-dir lookalike that is not the dir itself is still flagged", () => {
    expect(offendingLine(`node_modules/.${OLD}-deps`, [])).toBe(true);
    expect(offendingLine(`label: "dev.${OLD}.gateway"`, [])).toBe(true);
    expect(offendingLine(`lives in ~/.${OLD}.`, [])).toBe(false);
  });

  test("an allowed span does not hide a second mention on the same line", () => {
    expect(offendingLine(`~/.${OLD}/worktrees/${OLD}`, [])).toBe(true);
  });

  test("a mirror may spell the values it declares, and only those", () => {
    const value = LEGACY_IDS.mergeMarkersDir;
    expect(offendingLine(`MARKERS="$GITDIR/${value}"`, [value])).toBe(false);
    expect(offendingLine(`# the ${OLD} hook`, [value])).toBe(true);
  });
});
