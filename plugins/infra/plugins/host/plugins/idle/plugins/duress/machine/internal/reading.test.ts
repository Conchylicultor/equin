import { describe, expect, test } from "bun:test";
import { FRESHNESS_LEASE_MS } from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import { duressBlockerReading } from "./reading";

const NOW = Date.parse("2026-11-11T10:00:00Z");
const latch = { setAt: NOW - 5_000, reason: "swap pressure" };

describe("duressBlockerReading", () => {
  test("no latch is quiet", () => {
    expect(duressBlockerReading(null, NOW)).toEqual({
      busy: false,
      label: "no duress",
      recheckAt: null,
    });
  });

  test("a fresh latch is busy and asks to be re-read when its lease could lapse", () => {
    expect(duressBlockerReading({ latch, fresh: true }, NOW)).toEqual({
      busy: true,
      label: "under duress: swap pressure",
      recheckAt: NOW + FRESHNESS_LEASE_MS,
    });
  });

  test("a lapsed latch (its sentinel stopped refreshing) is quiet", () => {
    expect(duressBlockerReading({ latch, fresh: false }, NOW).busy).toBe(false);
  });
});
