import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { setPrototypePicks } from "./picks";

function apply(body: unknown, picks: Record<string, string>) {
  const [t] = readLiveEffect(setPrototypePicks.effect).resolve({
    params: { name: "proto-1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "value") throw new Error("value target");
  expect(t.params).toEqual({ name: "proto-1" });
  return t.apply(picks);
}

describe("setPrototypePicks effect", () => {
  test("a pick sets its option, keeping the others", () => {
    expect(apply({ kind: "set", option: "a", value: "x" }, { b: "y" })).toEqual(
      {
        b: "y",
        a: "x",
      },
    );
  });

  test("a reset empties the picks", () => {
    expect(apply({ kind: "reset" }, { a: "x" })).toEqual({});
  });
});
