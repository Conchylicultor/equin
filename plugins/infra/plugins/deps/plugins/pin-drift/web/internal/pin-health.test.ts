import { describe, expect, test } from "bun:test";
import type { PinDrift, PinnedDepRow } from "../../core";
import { pinDriftVerdict } from "./pin-health";

const refetch = async () => {};
const ready = (data: PinDrift) =>
  pinDriftVerdict({ status: "ready", data, refetch });
const checked = (...rows: PinnedDepRow[]) =>
  ready({ kind: "checked", mainRoot: "/repo", rows });

const v = (version: string) => ({ identity: `id-${version}`, version });
const row = (id: string, status: PinnedDepRow["status"]): PinnedDepRow => ({
  id,
  description: "",
  appliesAt: "the next restart",
  status,
  review: null,
});

describe("pinDriftVerdict", () => {
  test("loading is unknown, never ok", () => {
    expect(pinDriftVerdict({ status: "loading", refetch })).toEqual({
      state: "unknown",
    });
  });

  test("every pin on main's version, or none pinned yet, is ok", () => {
    expect(
      checked(
        row("postgres-binaries", {
          kind: "pinned",
          pinned: v("18.1.0"),
          running: null,
          declared: { kind: "same" },
        }),
        row("pgbouncer-binary", { kind: "unpinned" }),
      ),
    ).toEqual({ state: "ok", summary: "Up to date with main" });
  });

  test("a pin behind main, switchable or blocked, is attention naming each", () => {
    expect(
      checked(
        row("postgres-binaries", {
          kind: "pinned",
          pinned: v("18.1.0"),
          running: null,
          declared: {
            kind: "differs",
            install: v("19.0.0"),
            blocked: "PostgreSQL 18 → 19 is a major upgrade",
          },
        }),
        row("pgbouncer-binary", {
          kind: "pinned",
          pinned: v("1.24.0"),
          running: null,
          declared: { kind: "differs", install: v("1.24.1"), blocked: null },
        }),
      ),
    ).toEqual({
      state: "attention",
      title: "Pinned binaries lag main",
      summary:
        "postgres-binaries 18.1.0 → 19.0.0 blocked; pgbouncer-binary 1.24.0 → 1.24.1",
    });
  });

  test("a moved pin the daemon has not restarted onto is attention", () => {
    expect(
      checked(
        row("pgbouncer-binary", {
          kind: "pinned",
          pinned: v("1.24.1"),
          running: v("1.24.0"),
          declared: { kind: "same" },
        }),
      ),
    ).toMatchObject({
      state: "attention",
      summary: "pgbouncer-binary still runs 1.24.0, pinned 1.24.1",
    });
  });

  test("a lag's review: a stay in force is ok, a due or lapsed decision says so", () => {
    const behind: PinnedDepRow["status"] = {
      kind: "pinned",
      pinned: v("18.1.0"),
      running: null,
      declared: {
        kind: "differs",
        install: v("19.0.0"),
        blocked: "PostgreSQL 18 → 19 is a major upgrade",
      },
    };
    const reviewed = (review: PinnedDepRow["review"]) => ({
      ...row("postgres-binaries", behind),
      review,
    });
    const stay = {
      reason: "no major upgrade procedure",
      reviewBy: "2027-02-01",
    };
    expect(
      checked(
        reviewed({
          decision: "stayed",
          since: "2026-10-01T00:00:00.000Z",
          dueOn: "2026-10-31",
          stay,
        }),
      ),
    ).toEqual({
      state: "ok",
      summary: "postgres-binaries stays on 18.1.0 until 2027-02-01",
    });
    expect(
      checked(
        reviewed({
          decision: "due",
          since: "2026-10-01T00:00:00.000Z",
          dueOn: "2026-10-31",
          stay: null,
        }),
      ),
    ).toMatchObject({
      state: "attention",
      summary:
        "postgres-binaries 18.1.0 → 19.0.0 blocked — decision due since 2026-10-31",
    });
    expect(
      checked(
        reviewed({
          decision: "stay-lapsed",
          since: "2026-10-01T00:00:00.000Z",
          dueOn: "2026-10-31",
          stay,
        }),
      ),
    ).toMatchObject({
      state: "attention",
      summary:
        "postgres-binaries 18.1.0 → 19.0.0 blocked — staying was to be reviewed by 2027-02-01",
    });
    expect(
      checked(
        reviewed({
          decision: "within-bound",
          since: "2026-11-10T00:00:00.000Z",
          dueOn: "2026-12-10",
          stay: null,
        }),
      ),
    ).toMatchObject({
      state: "attention",
      summary:
        "postgres-binaries 18.1.0 → 19.0.0 blocked (decide by 2026-12-10)",
    });
  });

  test("an unreadable declaration is unknown, never ok", () => {
    expect(
      checked(
        row("postgres-binaries", {
          kind: "pinned",
          pinned: v("18.1.0"),
          running: null,
          declared: { kind: "failed", message: "no bun.lock" },
        }),
      ),
    ).toEqual({
      state: "unknown",
      summary: "postgres-binaries: couldn't read what main declares",
    });
  });

  test("a release, or no computer: out of the merge", () => {
    expect(ready({ kind: "not-applicable", reason: "A release" })).toEqual({
      state: "not-applicable",
      summary: "A release",
    });
    expect(
      pinDriftVerdict({ status: "unavailable", message: "Not here." }),
    ).toEqual({ state: "not-applicable", summary: "Not here." });
  });
});
