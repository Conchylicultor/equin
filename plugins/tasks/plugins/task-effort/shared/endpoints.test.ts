import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { putTaskEffort, deleteTaskEffort } from "./endpoints";

function only(
  endpoint: { effect: Parameters<typeof readLiveEffect>[0] },
  body: unknown,
) {
  const [t, ...rest] = readLiveEffect(endpoint.effect).resolve({
    params: { taskId: "taskId-1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row" || rest.length > 0) {
    throw new Error("expected exactly one row target");
  }
  return t;
}

describe("putTaskEffort effect", () => {
  test("upserts the row, compared on the chosen value", () => {
    const t = only(putTaskEffort, { level: "max" });
    expect(t.subject).toBe("collection:task-efforts");
    expect(t.id).toBe("taskId-1");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ level: "max" });
    expect(t.apply(undefined)).toMatchObject({
      taskId: "taskId-1",
      level: "max",
    });
  });

  test("replaces the value of a held row and keeps its other fields", () => {
    const t = only(putTaskEffort, { level: "max" });
    const held = {
      taskId: "taskId-1",
      level: "low",
      updatedAt: new Date("2026-01-01"),
    };
    expect(t.apply(held)).toEqual({ ...held, level: "max" });
  });
});

describe("deleteTaskEffort effect", () => {
  test("removes the row", () => {
    const t = only(deleteTaskEffort, undefined);
    expect(t.subject).toBe("collection:task-efforts");
    expect(t.removes).toBe(true);
    expect(t.apply({ taskId: "taskId-1" })).toBeUndefined();
  });
});
