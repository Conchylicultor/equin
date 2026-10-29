import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import { deleteTriggerEndpoint, patchTriggerEndpoint } from "./endpoints";

const rows = [
  { id: "t1", enabled: true },
  { id: "t2", enabled: true },
] as never;

function apply(effect: Parameters<typeof readLiveEffect>[0], body: unknown) {
  const [t] = readLiveEffect(effect).resolve({
    params: { id: "t1" },
    body,
  }).targets;
  if (t === undefined || t.kind !== "value") throw new Error("value target");
  expect(t.key).toBe("event-triggers");
  return t.apply(rows);
}

describe("trigger effects", () => {
  test("delete drops the trigger from the list", () => {
    expect(apply(deleteTriggerEndpoint.effect, undefined)).toEqual([
      { id: "t2", enabled: true },
    ]);
  });

  test("patch sets enabled on that trigger only", () => {
    expect(apply(patchTriggerEndpoint.effect, { enabled: false })).toEqual([
      { id: "t1", enabled: false },
      { id: "t2", enabled: true },
    ]);
  });
});
