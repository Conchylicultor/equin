import { describe, expect, test } from "bun:test";
import { planTmuxAdoption, type TmuxRow } from "./tmux-adoption";

const row = (over: Partial<TmuxRow> = {}): TmuxRow => ({
  id: "conv-1",
  status: "waiting",
  hibernatedAt: null,
  ...over,
});

describe("planTmuxAdoption", () => {
  test("kills a session this backend launched, and hibernates the row", () => {
    expect(
      planTmuxAdoption(
        row(),
        { kind: "live", parentHost: "singularity" },
        "singularity",
      ),
    ).toEqual({
      id: "conv-1",
      kill: true,
      hibernate: true,
      settleToWaiting: false,
    });
  });

  test("never kills another backend's session (a worktree's fork of main's rows)", () => {
    const step = planTmuxAdoption(
      row(),
      { kind: "live", parentHost: "singularity" },
      "att-123",
    );
    expect(step.kill).toBe(false);
    expect(step.hibernate).toBe(true);
  });

  test("never kills a session whose launcher is unknown", () => {
    expect(
      planTmuxAdoption(row(), { kind: "live", parentHost: null }, "singularity")
        .kill,
    ).toBe(false);
  });

  test("a working row is settled to waiting", () => {
    expect(
      planTmuxAdoption(row({ status: "working" }), { kind: "none" }, "x"),
    ).toMatchObject({ kill: false, hibernate: true, settleToWaiting: true });
  });

  test("an already-hibernated row keeps its stamp", () => {
    expect(
      planTmuxAdoption(
        row({ hibernatedAt: new Date(0) }),
        { kind: "none" },
        "x",
      ).hibernate,
    ).toBe(false);
  });

  test("gone and done rows only change runtime", () => {
    for (const status of ["gone", "done"]) {
      expect(planTmuxAdoption(row({ status }), { kind: "none" }, "x")).toEqual({
        id: "conv-1",
        kill: false,
        hibernate: false,
        settleToWaiting: false,
      });
    }
  });
});
