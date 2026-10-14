/**
 * history.versions's derived fields: the ids every list, saved view and filter preset names
 * are unchanged, and the columns it filters / sorts are the ones it declared
 * before its fields were derived.
 *
 * Run: `./singularity test plugins/history`.
 */

import { describe, expect, test } from "bun:test";
import { historyVersions } from "./live";

describe("history.versions fields", () => {
  test("the list fields keep their ids, in order", () => {
    expect(Object.keys(historyVersions.fields)).toEqual([
      "label",
      "createdAt",
      "author",
      "sourceId",
      "entityId",
    ]);
  });

  test("the filterable columns are the declared ones", () => {
    expect(Object.keys(historyVersions.filterable).sort()).toEqual(
      ["sourceId", "entityId"].sort(),
    );
  });

  test("the sortable columns are the declared ones", () => {
    expect([...historyVersions.sortable]).toEqual(["createdAt"]);
  });
});
