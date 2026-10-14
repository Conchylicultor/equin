/**
 * debug.boot-traces's derived fields: the ids every list, saved view and filter preset names
 * are unchanged, and the columns it filters / sorts are the ones it declared
 * before its fields were derived.
 *
 * Run: `./singularity test plugins/debug/plugins/boot-profile`.
 */

import { describe, expect, test } from "bun:test";
import { bootTraces } from "./resources";

describe("debug.boot-traces fields", () => {
  test("the list fields keep their ids, in order", () => {
    expect(Object.keys(bootTraces.fields)).toEqual([
      "worktree",
      "id",
      "createdAt",
    ]);
  });

  test("the filterable columns are the declared ones", () => {
    expect(Object.keys(bootTraces.filterable).sort()).toEqual(
      ["worktree", "createdAt"].sort(),
    );
  });

  test("the sortable columns are the declared ones", () => {
    expect([...bootTraces.sortable]).toEqual(["createdAt", "worktree"]);
  });
});
