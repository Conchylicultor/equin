import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComponentType } from "react";
import { computeHash, type JsonValue } from "@plugins/config_v2/core";
import { applyConfigMigrations } from "@plugins/config_v2/plugins/ledger/core";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type {
  ViewConfigRow,
  ViewSourceEntry,
  ViewTypeMeta,
} from "@plugins/primitives/plugins/data-view/plugins/view-core/core";
import { buildInstanceFromRow } from "@plugins/primitives/plugins/data-view/plugins/view-core/web/testing";
import { dataViewDescriptors } from "./descriptors";

/**
 * A user's saved `type: "tree"` row still loads now that no `tree` view-type is
 * registered: the build replays the descriptor's `tree-view-to-table` migration
 * over the saved files BEFORE anything reads them, so the resolver only ever
 * sees a `table` row. Driven through the real per-id descriptor, so dropping the
 * migration from `viewMigrations` (or the descriptor wiring) fails here.
 */

const ID = "agents-list";
const HIERARCHY = "conversations/agents";
const REL = `${HIERARCHY}/${ID}.jsonc`;

const Icon: ComponentType<{ className?: string }> = () => null;
/** Only the table is registered — the tree view-type is gone. */
const entry: ViewSourceEntry = {
  contributions: [
    { type: "table", title: "Table", icon: Icon },
  ] as unknown as SealContributions<ViewTypeMeta>[],
};

const savedRow = {
  id: "mine",
  name: "My tree",
  view: { type: "tree", filterScope: "roots", expandOnActivate: true },
};

let ns: string;

beforeEach(() => {
  ns = join(mkdtempSync(join(tmpdir(), "saved-tree-row-")), "wt");
  const file = join(ns, REL);
  mkdirSync(dirname(file), { recursive: true });
  const doc: JsonValue = { views: [savedRow] };
  writeFileSync(
    file,
    `// @hash ${computeHash(doc)}\n${JSON.stringify(doc, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(dirname(ns), { recursive: true, force: true });
});

describe("a saved tree row after the tree view-type is gone", () => {
  test("unmigrated, it would not resolve (why the migration must run first)", () => {
    expect(buildInstanceFromRow(savedRow as ViewConfigRow, [entry])).toBeNull();
  });

  test("the build's migration pass rewrites it into a table that resolves", () => {
    const descriptor = dataViewDescriptors.get(ID)!;
    applyConfigMigrations({
      userConfigDir: ns,
      configs: [{ hierarchyPath: HIERARCHY, descriptor }],
    });

    const raw = readFileSync(join(ns, REL), "utf8");
    const doc = JSON.parse(raw.replace(/^\/\/.*\n/, "")) as {
      views: ViewConfigRow[];
    };
    const resolved = buildInstanceFromRow(doc.views[0]!, [entry]);
    expect(resolved).not.toBeNull();
    expect(resolved!.instance.type).toBe("table");
    expect(resolved!.instance.options).toEqual({
      type: "table",
      presentation: "outline",
      filterScope: "roots",
      expandOnActivate: true,
    });
  });
});
