/**
 * The round trip is the point: the mint and the sweeper's read are the two
 * halves whose drift produced the original leak, and this pins them together.
 */
import { describe, test, expect } from "bun:test";
import {
  mintTestDbName,
  parseTestDbName,
  TEST_DB_SUFFIX,
} from "./scratch-name";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

describe("mintTestDbName / parseTestDbName", () => {
  test("round-trips prefix, pid and mint time", () => {
    const mintedAt = 1786061967071;
    const name = mintTestDbName("page_forest_test", 31023, mintedAt);
    expect(name).toBe(`page_forest_test_31023_msi76hun${TEST_DB_SUFFIX}`);
    expect(parseTestDbName(name)).toEqual({
      prefix: "page_forest_test",
      pid: 31023,
      mintedAt,
    });
  });

  test("declines names it did not mint", () => {
    // Every real namespace on the cluster takes this branch.
    expect(parseTestDbName(MAIN_WORKTREE_NAME)).toBeNull();
    expect(parseTestDbName("att-1788958976-i7bt")).toBeNull();
    expect(parseTestDbName("sonata.att-1787097707-cveo")).toBeNull();
    expect(parseTestDbName("wedge-repro-1")).toBeNull();
    // The pre-suffix leaked names: unreclaimable by design, which is exactly why
    // the suffix had to be introduced rather than the sweeper pattern-matching
    // `_test_` in the middle of a name a user could also have chosen.
    expect(parseTestDbName("page_forest_test_31023_msi76hun")).toBeNull();
    // A fork temp is another plugin's artifact with another plugin's sweep.
    expect(parseTestDbName("f_1a2b3c4d_deadbeef__forking")).toBeNull();
  });

  test("refuses a suffixed name whose provenance is unreadable", () => {
    // Nothing else mints the suffix, so a non-conforming body is a torn mint —
    // louder than silently leaving it on the cluster forever.
    expect(() => parseTestDbName(`not a mint${TEST_DB_SUFFIX}`)).toThrow(
      /does not match the minted grammar/,
    );
  });

  test("refuses a prefix the cluster's name guard would reject", () => {
    expect(() => mintTestDbName("Page-Forest", 1, 0)).toThrow(
      /Invalid test-database prefix/,
    );
  });

  test("refuses a name Postgres would silently truncate", () => {
    expect(() => mintTestDbName("x".repeat(60), 31023, Date.now())).toThrow(
      /truncates datname/,
    );
  });
});
