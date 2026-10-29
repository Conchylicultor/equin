import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { clearTaskAutoStart, setTaskAutoStart } from "./endpoints";

function targets(
  endpoint: { effect: Parameters<typeof readLiveEffect>[0] },
  params: Record<string, string>,
  body: unknown,
) {
  return readLiveEffect(endpoint.effect).resolve({ params, body }).targets;
}

function rowTarget(t: ReturnType<typeof targets>[number] | undefined) {
  if (t === undefined || t.kind !== "row")
    throw new Error("expected a row target");
  return t;
}

describe("auto-start markers", () => {
  const armed = { model: "opus" };

  test("arming upserts the marker with the chosen model, compared", () => {
    const t = rowTarget(targets(setTaskAutoStart, { id: "t1" }, armed)[0]);
    expect(t.subject).toBe("collection:tasks-auto-start");
    expect(t.enters).toBe(true);
    expect(t.set).toEqual({ autoStartModel: "opus" });
    const entered = t.apply(undefined) as Record<string, unknown>;
    expect(entered.taskId).toBe("t1");
    expect(entered.autoStartModel).toBe("opus");
    expect(entered.autoStartAt).toBeInstanceOf(Date);
  });

  test("re-arming keeps the arming time and swaps the model", () => {
    const at = new Date("2026-02-02");
    const t = rowTarget(targets(setTaskAutoStart, { id: "t1" }, armed)[0]);
    expect(
      t.apply({ taskId: "t1", autoStartAt: at, autoStartModel: "sonnet" }),
    ).toMatchObject({ autoStartAt: at, autoStartModel: "opus" });
  });

  test("disarming removes the marker", () => {
    const t = rowTarget(
      targets(clearTaskAutoStart, { id: "t1" }, undefined)[0],
    );
    expect(t.subject).toBe("collection:tasks-auto-start");
    expect(t.removes).toBe(true);
    expect(t.apply({ taskId: "t1" })).toBeUndefined();
  });
});
