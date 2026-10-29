import { describe, expect, test } from "bun:test";
import { isConnectionCapacityRefusal } from "./capacity-refusal";

// The shape node-postgres hands back for pgbouncer's refusal (copied from the
// 2026-10-28 worktree-prepare transcript): a DatabaseError with severity FATAL.
function pgbouncerFull(): Error {
  return Object.assign(
    new Error("no more connections allowed (max_client_conn)"),
    { code: "08P01", severity: "FATAL" },
  );
}

describe("isConnectionCapacityRefusal", () => {
  test("pgbouncer's max_client_conn refusal", () => {
    expect(isConnectionCapacityRefusal(pgbouncerFull())).toBe(true);
  });

  test("Postgres's too_many_connections", () => {
    const err = Object.assign(new Error("sorry, too many clients already"), {
      code: "53300",
    });
    expect(isConnectionCapacityRefusal(err)).toBe(true);
  });

  test("another 08P01 is a protocol violation, not capacity", () => {
    const err = Object.assign(new Error("invalid startup packet layout"), {
      code: "08P01",
    });
    expect(isConnectionCapacityRefusal(err)).toBe(false);
  });

  test("unrelated connect failures are not capacity", () => {
    for (const err of [
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
      Object.assign(new Error('database "x" does not exist'), {
        code: "3D000",
      }),
      new Error("boom"),
      "no more connections allowed",
      null,
      undefined,
    ]) {
      expect(isConnectionCapacityRefusal(err)).toBe(false);
    }
  });

  test("found through a cause (awaitDbReady's deadline wraps the last error)", () => {
    const wrapped = new Error(
      "Database did not become reachable within 30000ms",
      {
        cause: pgbouncerFull(),
      },
    );
    expect(isConnectionCapacityRefusal(wrapped)).toBe(true);
  });

  test("found inside an AggregateError", () => {
    const agg = new AggregateError([new Error("other"), pgbouncerFull()], "x");
    expect(isConnectionCapacityRefusal(agg)).toBe(true);
  });

  test("a cause cycle terminates", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isConnectionCapacityRefusal(a)).toBe(false);
  });
});
