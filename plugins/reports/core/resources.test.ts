/**
 * reports.list's derived fields: the ids every list, saved view and filter preset names
 * are unchanged, and the columns it filters / sorts are the ones it declared
 * before its fields were derived.
 *
 * Run: `./singularity test plugins/reports`.
 */

import { describe, expect, test } from "bun:test";
import { reportsList } from "./resources";

describe("reports.list fields", () => {
  test("the list fields keep their ids, in order", () => {
    expect(Object.keys(reportsList.fields)).toEqual([
      "kind",
      "source",
      "noise",
      "rateLimited",
      "count",
      "lastSeenAt",
      "message",
      "fingerprint",
    ]);
  });

  test("the filterable columns are the declared ones", () => {
    expect(Object.keys(reportsList.filterable).sort()).toEqual(
      [
        "kind",
        "source",
        "noise",
        "rateLimited",
        "count",
        "lastSeenAt",
        "message",
        "fingerprint",
      ].sort(),
    );
  });

  test("the sortable columns are the declared ones", () => {
    expect([...reportsList.sortable]).toEqual([
      "kind",
      "source",
      "count",
      "lastSeenAt",
    ]);
  });
});
