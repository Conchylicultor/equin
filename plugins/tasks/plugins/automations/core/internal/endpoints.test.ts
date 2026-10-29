import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { decideLaunchEndpoint, taskApprovalEndpoint } from "./endpoints";

function resolve(
  endpoint: { effect: Parameters<typeof readLiveEffect>[0] },
  params: Record<string, string>,
  body: unknown,
) {
  return readLiveEffect(endpoint.effect).resolve({ params, body }).targets;
}

const approvedRow = {
  taskId: "t1",
  decision: "approved",
  decidedAt: new Date(0),
};
const excludedRow = {
  taskId: "t1",
  decision: "excluded",
  decidedAt: new Date(0),
};

describe("taskApprovalEndpoint effect", () => {
  test("approving upserts an approved row over an exclusion", () => {
    const [t] = resolve(
      taskApprovalEndpoint,
      { taskId: "t1" },
      { approved: true },
    );
    if (t === undefined || t.kind !== "row") throw new Error("row target");
    expect(t.subject).toBe("collection:automations.launch-decisions.all");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ decision: "approved" });
    expect(t.apply(excludedRow)).toMatchObject({ decision: "approved" });
  });

  test("taking it back removes only an approved row", () => {
    const [t] = resolve(
      taskApprovalEndpoint,
      { taskId: "t1" },
      { approved: false },
    );
    if (t === undefined || t.kind !== "rows") throw new Error("rows target");
    expect(t.ids).toEqual(["t1"]);
    expect(t.apply([approvedRow])).toEqual([]);
    expect(t.apply([excludedRow])).toEqual([excludedRow]);
  });
});

describe("decideLaunchEndpoint effect", () => {
  const params = { automationId: "a" };

  test("clearing removes the decided tasks' rows", () => {
    const [t] = resolve(decideLaunchEndpoint, params, {
      taskIds: ["t1"],
      decision: null,
    });
    if (t === undefined || t.kind !== "rows") throw new Error("rows target");
    expect(t.ids).toEqual(["t1"]);
    expect(t.apply([approvedRow])).toEqual([]);
  });

  test("deciding upserts one row per task, entering the ones with no decision yet", () => {
    const targets = resolve(decideLaunchEndpoint, params, {
      taskIds: ["t1", "t2"],
      decision: "excluded",
    });
    expect(targets.map((t) => (t.kind === "row" ? t.id : null))).toEqual([
      "t1",
      "t2",
    ]);
    const [t1, t2] = targets;
    if (t1?.kind !== "row" || t2?.kind !== "row")
      throw new Error("row targets");
    expect(t1.enters).toBe(true);
    expect(t1.set).toEqual({ decision: "excluded" });
    expect(t1.apply(approvedRow)).toMatchObject({
      taskId: "t1",
      decision: "excluded",
    });
    expect(t2.apply(undefined)).toMatchObject({
      taskId: "t2",
      decision: "excluded",
    });
  });
});
