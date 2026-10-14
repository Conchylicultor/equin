/**
 * event-emissions's derived fields: the ids every list, saved view and filter preset names
 * are unchanged, and the columns it filters / sorts are the ones it declared
 * before its fields were derived.
 *
 * Run: `./singularity test plugins/infra/plugins/events`.
 */

import { describe, expect, test } from "bun:test";
import { eventEmissions } from "./resources";

describe("event-emissions fields", () => {
  test("the list fields keep their ids, in order", () => {
    expect(Object.keys(eventEmissions.fields)).toEqual([
      "emittedAt",
      "eventName",
      "matchedCount",
      "match",
    ]);
  });

  test("the filterable columns are the declared ones", () => {
    expect(Object.keys(eventEmissions.filterable).sort()).toEqual(
      ["emittedAt", "eventName", "matchedCount", "match"].sort(),
    );
  });

  test("the sortable columns are the declared ones", () => {
    expect([...eventEmissions.sortable]).toEqual([
      "emittedAt",
      "eventName",
      "matchedCount",
    ]);
  });
});
