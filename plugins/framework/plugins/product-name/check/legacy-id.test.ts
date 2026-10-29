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

  test("an env var's old name is flagged, except in a mirror that spells the prefix", () => {
    const name = `${OLD.toUpperCase()}_DIR`;
    expect(offendingLine(`process.env.${name}`, [])).toBe(true);
    expect(
      offendingLine(`\${NEW_DIR:-$${name}}`, [`${OLD.toUpperCase()}_`]),
    ).toBe(false);
  });

  test("flags a repository URL under the old name", () => {
    expect(offendingLine(`https://github.com/Owner/${OLD}/pull/1`, [])).toBe(
      true,
    );
  });

  test("the legacy data dir is flagged outside the mirrors that spell it", () => {
    const dir = LEGACY_IDS.dataDirName;
    expect(offendingLine(`~/${dir}/worktrees/x`, [])).toBe(true);
    expect(offendingLine(`"$HOME/${dir}"`, [])).toBe(true);
    expect(offendingLine(`legacy="$HOME/${dir}"`, [dir])).toBe(false);
    expect(offendingLine(`label: "dev.${OLD}.gateway"`, [])).toBe(true);
  });

  test("a mirror may spell the values it declares, and only those", () => {
    const value = LEGACY_IDS.mergeMarkersDir;
    expect(offendingLine(`MARKERS="$GITDIR/${value}"`, [value])).toBe(false);
    expect(offendingLine(`# the ${OLD} hook`, [value])).toBe(true);
  });
});
