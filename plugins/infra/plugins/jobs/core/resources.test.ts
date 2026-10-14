/**
 * dead-jobs's derived fields: the ids every list, saved view and filter preset names
 * are unchanged, and the columns it filters / sorts are the ones it declared
 * before its fields were derived.
 *
 * Run: `./singularity test plugins/infra/plugins/jobs`.
 */

import { describe, expect, test } from "bun:test";
import { deadJobs } from "./resources";

describe("dead-jobs fields", () => {
  test("the list fields keep their ids, in order", () => {
    expect(Object.keys(deadJobs.fields)).toEqual([
      "jobName",
      "attempts",
      "diedAt",
      "lastError",
      "archivedAt",
    ]);
  });

  test("the filterable columns are the declared ones", () => {
    expect(Object.keys(deadJobs.filterable).sort()).toEqual(
      ["jobName", "attempts", "diedAt", "lastError", "archivedAt"].sort(),
    );
  });

  test("the sortable columns are the declared ones", () => {
    expect([...deadJobs.sortable]).toEqual([
      "archivedAt",
      "diedAt",
      "jobName",
      "attempts",
    ]);
  });
});
