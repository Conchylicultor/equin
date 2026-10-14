/**
 * release.history's derived fields: the ids every list, saved view and filter preset names
 * are unchanged, and the columns it filters / sorts are the ones it declared
 * before its fields were derived.
 *
 * Run: `./singularity test plugins/release`.
 */

import { describe, expect, test } from "bun:test";
import { releaseHistory } from "./resources";

describe("release.history fields", () => {
  test("the list fields keep their ids, in order", () => {
    expect(Object.keys(releaseHistory.fields)).toEqual([
      "target",
      "status",
      "platform",
      "startedAt",
      "finishedAt",
      "composition",
    ]);
  });

  test("the filterable columns are the declared ones", () => {
    expect(Object.keys(releaseHistory.filterable).sort()).toEqual(
      [
        "target",
        "status",
        "platform",
        "startedAt",
        "finishedAt",
        "composition",
      ].sort(),
    );
  });

  test("the sortable columns are the declared ones", () => {
    expect([...releaseHistory.sortable]).toEqual([
      "target",
      "status",
      "platform",
      "startedAt",
      "finishedAt",
    ]);
  });
});
