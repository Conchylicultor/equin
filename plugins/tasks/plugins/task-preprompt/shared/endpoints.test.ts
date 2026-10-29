import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { putTaskPreprompt, deleteTaskPreprompt } from "./endpoints";

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

describe("putTaskPreprompt effect", () => {
  test("upserts the row, compared on the chosen value", () => {
    const t = only(putTaskPreprompt, { prepromptId: "p2" });
    expect(t.subject).toBe("collection:task-preprompts");
    expect(t.id).toBe("taskId-1");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ prepromptId: "p2" });
    expect(t.apply(undefined)).toMatchObject({
      taskId: "taskId-1",
      prepromptId: "p2",
    });
  });

  test("replaces the value of a held row and keeps its other fields", () => {
    const t = only(putTaskPreprompt, { prepromptId: "p2" });
    const held = {
      taskId: "taskId-1",
      prepromptId: "p1",
      updatedAt: new Date("2026-01-01"),
    };
    expect(t.apply(held)).toEqual({ ...held, prepromptId: "p2" });
  });
});

describe("deleteTaskPreprompt effect", () => {
  test("removes the row", () => {
    const t = only(deleteTaskPreprompt, undefined);
    expect(t.subject).toBe("collection:task-preprompts");
    expect(t.removes).toBe(true);
    expect(t.apply({ taskId: "taskId-1" })).toBeUndefined();
  });
});
