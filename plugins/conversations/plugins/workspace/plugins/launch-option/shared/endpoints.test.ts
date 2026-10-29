import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { deleteTaskWorkspace, putTaskWorkspace } from "./endpoints";

function only(
  endpoint: { effect: Parameters<typeof readLiveEffect>[0] },
  body: unknown,
) {
  const [t, ...rest] = readLiveEffect(endpoint.effect).resolve({
    params: { taskId: "task-1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "row" || rest.length > 0) {
    throw new Error("expected exactly one row target");
  }
  return t;
}

const spec = { kind: "worktree" };

describe("putTaskWorkspace effect", () => {
  test("upserts the row, compared on the spec", () => {
    const t = only(putTaskWorkspace, { spec });
    expect(t.subject).toBe("collection:task-workspaces");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ spec });
    expect(t.apply(undefined)).toMatchObject({ taskId: "task-1", spec });
  });
});

describe("deleteTaskWorkspace effect", () => {
  test("removes the row", () => {
    const t = only(deleteTaskWorkspace, undefined);
    expect(t.removes).toBe(true);
    expect(t.apply({ taskId: "task-1" })).toBeUndefined();
  });
});
