import { describe, expect, test } from "bun:test";
import { AWAIT_MAX_DAYS, awaitingOrBlocked, boundedRows } from "./awaiting";
import type { AwaitingOn } from "./updater";

const SINCE = "2026-10-01T00:00:00.000Z";
const DAY_MS = 86_400_000;
const after = (days: number) => new Date(Date.parse(SINCE) + days * DAY_MS);

const publish: AwaitingOn = {
  kind: "publish",
  by: ["@embedded-postgres"],
  release: "PostgreSQL 18.6",
  since: SINCE,
};

describe("awaitingOrBlocked", () => {
  test("a publish wait up to its bound is still awaited", () => {
    expect(awaitingOrBlocked(publish, after(1))).toEqual({
      kind: "awaiting",
      on: publish,
    });
    expect(awaitingOrBlocked(publish, after(AWAIT_MAX_DAYS))).toEqual({
      kind: "awaiting",
      on: publish,
    });
  });

  test("past it the wait is BLOCKED on deciding what to do instead", () => {
    expect(awaitingOrBlocked(publish, after(AWAIT_MAX_DAYS + 1))).toEqual({
      kind: "blocked",
      prerequisite:
        "waited 31 days (since 2026-10-01) for @embedded-postgres to publish PostgreSQL 18.6: add a hold on it in this updater's holds file (a `reason`, the upstream `issue` URL and a `reviewBy`), chase upstream, or replace the dependency",
    });
  });

  test("a cooldown wait never escalates", () => {
    const cooldown: AwaitingOn = {
      kind: "cooldown",
      of: ["cli"],
      until: SINCE,
    };
    expect(awaitingOrBlocked(cooldown, after(365))).toEqual({
      kind: "awaiting",
      on: cooldown,
    });
  });

  test("a since that is no instant fails loudly", () => {
    expect(() =>
      awaitingOrBlocked({ ...publish, since: "soon" }, after(1)),
    ).toThrow("not an instant");
  });
});

describe("boundedRows", () => {
  test("bounds the awaiting rows and leaves every other row as it is", () => {
    const move = { name: "vite", current: "6.4.2", latest: "7.1.0" };
    const held = {
      name: "react",
      current: "19.1.0",
      latest: "20.0.0",
      waiting: {
        kind: "held" as const,
        reason: "x",
        reviewBy: "2026-12-01",
        lapsed: false,
      },
    };
    const waiting = {
      name: "PostgreSQL",
      current: "18.3.0",
      latest: "18.6.0",
      waiting: { kind: "awaiting" as const, on: publish },
    };
    const rows = boundedRows([move, held, waiting], after(40));
    expect(rows[0]).toEqual(move);
    expect(rows[1]).toEqual(held);
    expect(rows[2]?.waiting?.kind).toBe("blocked");
  });
});
