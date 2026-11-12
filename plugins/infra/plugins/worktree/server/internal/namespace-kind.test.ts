/**
 * What a namespace-named thing is, from the evidence its producer left.
 *
 * Run: `./equin test plugins/infra/plugins/worktree`
 */

import { describe, test, expect } from "bun:test";
import {
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { classifyNamespace, isPersistentNamespace } from "./namespace-kind";

/** Namespaces with a `composition.json` marker on disk. */
const MARKED = new Set(["sonata", "sonata.att-1790000000-abcd"]);
const hasMarker = (ns: Namespace) => Promise.resolve(MARKED.has(ns));

describe("classifyNamespace", () => {
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
    // Not a namespace at all.
    ["page_forest_test_60438_mtutbt9f", "orphan"],
  ] as const)("%s → %s", async (name, kind) => {
    expect(await classifyNamespace(name, hasMarker)).toBe(kind);
  });

  test("only the main app and composition apps persist", () => {
    expect(isPersistentNamespace("main")).toBe(true);
    expect(isPersistentNamespace("composition")).toBe(true);
    expect(isPersistentNamespace("worktree")).toBe(false);
    expect(isPersistentNamespace("orphan")).toBe(false);
  });
});
