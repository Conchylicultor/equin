import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { deleteCustomColumnValues, setCustomColumnValue } from "./endpoints";

function cells(def: { effect: unknown }, body: unknown, held: unknown[]) {
  const [t] = readLiveEffect(def.effect as never).resolve({
    params: {},
    body,
  }).targets;
  if (t?.kind !== "value") throw new Error("expected a value target");
  expect(t.params).toEqual({ dataViewId: "dv" });
  return t.apply(held);
}

const held = [
  { rowKey: "r1", columnId: "a", value: "x" },
  { rowKey: "r1", columnId: "b", value: "y" },
  { rowKey: "r2", columnId: "a", value: "z" },
];

describe("custom-column value effects", () => {
  test("a value replaces the cell", () => {
    const next = cells(
      setCustomColumnValue,
      { dataViewId: "dv", rowKey: "r1", columnId: "a", value: "new" },
      held,
    ) as typeof held;
    expect(
      next.find((c) => c.rowKey === "r1" && c.columnId === "a")?.value,
    ).toBe("new");
    expect(next).toHaveLength(3);
  });
  test("a value for an absent cell adds it", () => {
    const next = cells(
      setCustomColumnValue,
      { dataViewId: "dv", rowKey: "r9", columnId: "a", value: "v" },
      held,
    ) as typeof held;
    expect(next).toHaveLength(4);
  });
  test("an empty value deletes the cell", () => {
    const next = cells(
      setCustomColumnValue,
      { dataViewId: "dv", rowKey: "r1", columnId: "a", value: "" },
      held,
    ) as typeof held;
    expect(next).toHaveLength(2);
  });
  test("deleting a column drops its cells everywhere", () => {
    const next = cells(
      deleteCustomColumnValues,
      { dataViewId: "dv", columnId: "a" },
      held,
    ) as typeof held;
    expect(next).toEqual([held[1]!]);
  });
});
