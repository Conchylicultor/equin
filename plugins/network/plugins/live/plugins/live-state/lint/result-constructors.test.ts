/**
 * The result-constructor table cannot drift: every row's `name` is exported,
 * as a value, from its `from` barrel — read statically from the barrel's
 * source (a lint folder may not import a web barrel), so a rename or a removal
 * fails here rather than leaving the lint message pointing at nothing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  RESULT_CONSTRUCTORS,
  RESULT_OWNERS,
  resultConstructorsMessage,
} from "./result-constructors";

/** The repo root: this file sits at plugins/network/plugins/live/plugins/live-state/lint/. */
const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));

/** The value (non-type) names a barrel exports. */
function valueExports(barrel: string): Set<string> {
  const file = `${ROOT}${barrel.slice("@".length)}/index.ts`;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
  );
  const names = new Set<string>();
  for (const stmt of source.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly) continue;
    const clause = stmt.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) continue;
    for (const el of clause.elements) {
      if (!el.isTypeOnly) names.add(el.name.text);
    }
  }
  return names;
}

describe("RESULT_CONSTRUCTORS", () => {
  test.each(RESULT_CONSTRUCTORS.map((c) => [c.name, c.from] as const))(
    "%s is exported from %s",
    (name, from) => {
      expect(valueExports(from).has(name)).toBe(true);
    },
  );

  test("names each constructor once", () => {
    const names = RESULT_CONSTRUCTORS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("derives the owning plugins from the barrels", () => {
    expect([...RESULT_OWNERS].sort()).toEqual([
      "/plugins/network/plugins/live/",
      "/plugins/network/plugins/live/plugins/live-state/",
      "/plugins/network/plugins/live/plugins/optimistic-mutation/",
    ]);
  });

  test("the message names every constructor", () => {
    const message = resultConstructorsMessage();
    for (const c of RESULT_CONSTRUCTORS) expect(message).toContain(c.name);
  });
});
