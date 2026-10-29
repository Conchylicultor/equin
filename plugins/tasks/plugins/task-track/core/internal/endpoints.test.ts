import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { putTaskTrack } from "./endpoints";

function only(body: unknown) {
  const [t, ...rest] = readLiveEffect(putTaskTrack.effect).resolve({
    params: { taskId: "task-1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row" || rest.length > 0) {
    throw new Error("expected exactly one row target");
  }
  return t;
}

describe("putTaskTrack effect", () => {
  test("a sidequest upserts its track row, compared on the track", () => {
    const t = only({ track: "sidequest" });
    expect(t.subject).toBe("collection:task-tracks.all");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ track: "sidequest" });
    expect(t.apply(undefined)).toMatchObject({
      taskId: "task-1",
      track: "sidequest",
    });
  });

  test("main has no row: it removes the stored one", () => {
    const t = only({ track: "main" });
    expect(t.removes).toBe(true);
    expect(t.apply({ taskId: "task-1", track: "sidequest" })).toBeUndefined();
  });
});
