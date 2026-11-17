import { describe, expect, test } from "bun:test";
import type { ReleaseStatus } from "@plugins/upstream/plugins/release/core";
import {
  deriveUpdatesView,
  updatesHealth,
  type MergeRun,
  type Read,
  type UpdatesInputs,
} from "./updates-view";

const refetch = async () => {};
const ready = <T>(data: T): Read<T> => ({ status: "ready", data, refetch });
const loading = <T>(): Read<T> => ({ status: "loading", refetch });
const checkedAt = "2026-11-17T05:00:00.000Z";

const behind: ReleaseStatus = {
  kind: "behind",
  current: "v2026.10.30",
  latest: "v2026.11.14",
  checkedAt,
};
const current: ReleaseStatus = {
  kind: "current",
  current: "v2026.11.14",
  latest: "v2026.11.14",
  installed: true,
  checkedAt,
};

function inputs(over: Partial<UpdatesInputs>): UpdatesInputs {
  return {
    release: ready(behind),
    task: ready({ taskId: null }),
    runs: loading(),
    ...over,
  };
}

const health = (over: Partial<UpdatesInputs>) =>
  updatesHealth(deriveUpdatesView(inputs(over)));

const run = (status: MergeRun["status"]): MergeRun => ({
  id: "conv-1",
  status,
});

describe("the updates row", () => {
  test("is checking while the release status loads", () => {
    expect(health({ release: loading() })).toEqual({ state: "unknown" });
  });

  test.each<ReleaseStatus>([
    { kind: "unknown" },
    { kind: "no-upstream" },
    { kind: "no-release", current: null, checkedAt },
  ])("is absent with nothing to update from (%o)", (status) => {
    expect(health({ release: ready(status) })).toEqual({ state: "absent" });
  });

  test("is absent on a host without the computer", () => {
    expect(
      health({ release: { status: "unavailable", message: "no machine" } }),
    ).toEqual({ state: "absent" });
  });

  test("out of date: attention drawn, but the dot stays green", () => {
    expect(health({})).toEqual({
      state: "attention",
      title: "equin is out of date",
      summary: "2026.10.30 → 2026.11.14",
      ambient: [],
    });
  });

  test("out of date holding no release names the new one alone", () => {
    expect(
      health({ release: ready({ ...behind, current: null }) }),
    ).toMatchObject({ summary: "2026.11.14 available" });
  });

  test("an update whose agent works is ok and pulsing", () => {
    expect(
      health({
        task: ready({ taskId: "task-1" }),
        runs: ready([run("done"), run("working")]),
      }),
    ).toEqual({
      state: "ok",
      title: "Update in progress",
      summary: "2026.10.30 → 2026.11.14",
      transitioning: true,
    });
  });

  test.each<MergeRun["status"]>(["waiting", "done", "gone"])(
    "an update whose agent is at rest (%s) needs the user",
    (status) => {
      expect(
        health({
          task: ready({ taskId: "task-1" }),
          runs: ready([run(status)]),
        }),
      ).toEqual({
        state: "attention",
        title: "Update in progress",
        summary: "2026.10.30 → 2026.11.14",
      });
    },
  );

  test("an update task never started needs the user", () => {
    expect(
      health({ task: ready({ taskId: "task-1" }), runs: ready([]) }),
    ).toMatchObject({ state: "attention", title: "Update in progress" });
  });

  test("installing while main does not serve a build of the release yet", () => {
    expect(
      health({
        release: ready({ ...current, installed: false }),
      }),
    ).toEqual({
      state: "ok",
      title: "Installing",
      summary: "2026.11.14",
      transitioning: true,
    });
  });

  test("up to date once main serves it", () => {
    expect(health({ release: ready(current) })).toEqual({
      state: "ok",
      title: "equin is up to date",
      summary: "2026.11.14",
    });
  });
});
