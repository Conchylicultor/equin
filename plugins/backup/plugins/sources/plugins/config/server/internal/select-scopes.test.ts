/**
 * Which config subtrees the backup takes: the persistent namespaces only.
 *
 * Run: `./equin test plugins/backup/plugins/sources/plugins/config`
 */

import { describe, test, expect } from "bun:test";
import {
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  classifyScopes,
  describeLeftOut,
  backedUpScopes,
} from "./select-scopes";

/** Namespaces with a `composition.json` marker on disk. */
const MARKED = new Set(["sonata", "website.att-1794490520-fdd74g"]);
const hasMarker = (ns: Namespace) => Promise.resolve(MARKED.has(ns));

describe("config scopes", () => {
  test("every subtree but a worktree's is copied; worktrees are never touched", async () => {
    const classified = await classifyScopes(
      [
        MAIN_WORKTREE_NAME,
        "sonata",
        // The subtree a reap removed mid-copy (report-1794452517-7v3y31).
        "att-1794191531-5grztv",
        "att-1794505470-f7fnnc",
        "website.att-1794490520-fdd74g",
        "jovial-bell-b5af86",
      ],
      hasMarker,
    );
    expect(backedUpScopes(classified).map((s) => s.name)).toEqual([
      MAIN_WORKTREE_NAME,
      "sonata",
      "jovial-bell-b5af86",
    ]);
    expect(describeLeftOut(classified)).toEqual([
      {
        label: "3 worktree config copies",
        detail: "disposable, reaped with their checkout, never backed up",
        count: 3,
      },
    ]);
  });
});
