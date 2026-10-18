// The runtime-owned loader → table read-set (`./read-set`): the union `_debug`
// shows, and the per-run capture the drift guard judges and the L2 persist
// seam stores. Module state is process-wide, so each test uses its own keys.
import { describe, expect, test } from "bun:test";
import {
  getLastLoaderReadSet,
  getReadSetIndex,
  readSetOf,
  recordLoaderReadSet,
  removeReadSetTable,
} from "./read-set";

describe("read-set — union vs per-run capture", () => {
  test("the index unions every run; the per-run capture is only the LAST run", () => {
    recordLoaderReadSet(
      "u-attempts",
      new Set(["attempts_v", "conversations_v"]),
    );
    recordLoaderReadSet("u-attempts", new Set(["attempts_v"]));
    expect(readSetOf("u-attempts")).toEqual(["attempts_v", "conversations_v"]);
    expect(getLastLoaderReadSet("u-attempts")).toEqual(["attempts_v"]);
  });

  test("a run that read nothing changes neither", () => {
    recordLoaderReadSet("u-p", new Set(["p_table"]));
    recordLoaderReadSet("u-p", new Set());
    expect(readSetOf("u-p")).toEqual(["p_table"]);
    expect(getLastLoaderReadSet("u-p")).toEqual(["p_table"]);
  });

  test("undefined per-run capture and [] read-set for a key no loader ran", () => {
    expect(getLastLoaderReadSet("u-never-ran")).toBeUndefined();
    expect(readSetOf("u-never-ran")).toEqual([]);
    expect("u-never-ran" in getReadSetIndex()).toBe(false);
  });
});

describe("read-set — removeReadSetTable", () => {
  test("evicts a table from non-kept keys, leaving kept keys untouched", () => {
    recordLoaderReadSet(
      "r-attempts",
      new Set(["attempts_v", "r-notifications"]),
    );
    recordLoaderReadSet("r-notifications", new Set(["r-notifications"]));
    const changed = removeReadSetTable("r-notifications", ["r-notifications"]);
    expect(changed).toEqual(["r-attempts"]);
    const index = getReadSetIndex();
    expect(index["r-attempts"]).toEqual(["attempts_v"]);
    expect(index["r-notifications"]).toEqual(["r-notifications"]); // kept
  });

  test("a removal that matches nothing changes nothing", () => {
    expect(removeReadSetTable("r-no-such-table", [])).toEqual([]);
  });
});
