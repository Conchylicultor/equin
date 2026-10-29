import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { setRowOrder } from "./endpoints";

describe("setRowOrder effect", () => {
  test("replaces and adds the written rows, rank-ascending, for the view instance's tuple", () => {
    const [r1, r2, r3] = Rank.nBetween(null, null, 3);
    const body = {
      dataViewId: "dv",
      viewId: "v",
      writes: [
        { rowKey: "c", rank: r1! },
        { rowKey: "a", rank: r2! },
      ],
    };
    const [t] = readLiveEffect(setRowOrder.effect as never).resolve({
      params: {},
      body,
    }).targets;
    if (t?.kind !== "value") throw new Error("expected a value target");
    expect(t.params).toEqual({ dataViewId: "dv", viewId: "v" });
    const next = t.apply([
      { rowKey: "a", rank: r3! },
      { rowKey: "b", rank: r3! },
    ]) as { rowKey: string }[];
    expect(next.map((r) => r.rowKey)).toEqual(["c", "a", "b"]);
  });
});
