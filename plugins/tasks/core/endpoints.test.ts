import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { updateTask } from "./endpoints";

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

const row = {
  id: "t1",
  title: "Old",
  titleAuto: true,
  description: "d",
  droppedAt: null,
  heldAt: new Date("2026-01-01"),
};

describe("updateTask effect", () => {
  const apply = (body: unknown) => {
    const t = rowTarget(targets(updateTask, { id: "t1" }, body)[0]);
    expect(t.subject).toBe("tasks");
    expect(t.id).toBe("t1");
    return t;
  };

  test("a title is human-authored: it clears titleAuto, and both are compared", () => {
    const t = apply({ title: "New" });
    expect(t.apply(row)).toMatchObject({ title: "New", titleAuto: false });
    expect(t.set).toEqual({ title: "New", titleAuto: false });
  });

  test("a description (even null) is compared", () => {
    expect(apply({ description: null }).set).toEqual({ description: null });
    expect(apply({ description: "x" }).apply(row)).toMatchObject({
      description: "x",
    });
  });

  test("drop stamps droppedAt (shown, not compared) and clears hold", () => {
    const t = apply({ drop: true });
    const next = t.apply(row) as Record<string, unknown>;
    expect(next.droppedAt).toBeInstanceOf(Date);
    expect(next.heldAt).toBeNull();
    expect(t.set).toEqual({ heldAt: null });
  });

  test("hold stamps heldAt and clears a drop", () => {
    const t = apply({ hold: true });
    const next = t.apply({
      ...row,
      heldAt: null,
      droppedAt: new Date(),
    }) as Record<string, unknown>;
    expect(next.heldAt).toBeInstanceOf(Date);
    expect(next.droppedAt).toBeNull();
    expect(t.set).toEqual({ droppedAt: null });
  });

  test("undrop and unhold only clear their own timestamp", () => {
    expect(apply({ drop: false }).set).toEqual({ droppedAt: null });
    expect(apply({ hold: false }).set).toEqual({ heldAt: null });
  });

  test("the derived status is not predicted", () => {
    expect(apply({ drop: true }).apply(row)).not.toHaveProperty("status");
  });
});
