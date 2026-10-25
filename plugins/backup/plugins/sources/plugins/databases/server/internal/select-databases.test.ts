/**
 * Which databases the backup takes, decided from what each one is.
 *
 * Run: `./equin test plugins/backup/plugins/sources/plugins/databases`
 */

import { describe, test, expect } from "bun:test";
import { mintTestDbName } from "@plugins/database/plugins/db-test-fixture/core/testing";
import {
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { classifyDatabase, isBackedUp } from "./select-databases";

/** Namespaces with a `composition.json` marker on disk. */
const MARKED = new Set(["sonata", "sonata.att-1790000000-abcd"]);
const hasMarker = (ns: Namespace) => MARKED.has(ns);

const kindOf = (name: string) => classifyDatabase(name, hasMarker);

describe("classifyDatabase", () => {
  test.each([
    [MAIN_WORKTREE_NAME, "main"],
    ["sonata", "composition"],
    // A composition whose namespace directory is gone: nothing owns it.
    ["website", "orphan"],
    ["att-1790171312-b66v", "worktree"],
    ["claude-1780000000", "worktree"],
    ["sonata.att-1790000000-abcd", "worktree"],
    // A composition checkout whose directory is gone: nothing reclaims it.
    ["sonata.att-1787097707-cveo", "orphan"],
    [mintTestDbName("page_forest_test", 60438, 1_790_000_000_000), "test"],
    // Minted before the test grammar existed — not a namespace, not a test db.
    ["page_forest_test_60438_mtutbt9f", "orphan"],
    ["f_1a2b3c4d_deadbeef__forking", "fork-temp"],
  ] as const)("%s → %s", (name, kind) => {
    expect(kindOf(name)).toBe(kind);
  });

  test("only the main app and composition apps are backed up", () => {
    expect(isBackedUp("main")).toBe(true);
    expect(isBackedUp("composition")).toBe(true);
    for (const kind of ["worktree", "test", "fork-temp", "orphan"] as const) {
      expect(isBackedUp(kind)).toBe(false);
    }
  });
});
