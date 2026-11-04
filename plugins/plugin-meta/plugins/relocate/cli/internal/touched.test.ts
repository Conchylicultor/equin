import { describe, expect, test } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { pluginMoveKey, type PluginMove } from "../../core";
import { judgeDirt, parsePorcelainZ } from "./touched";

const LEDGER = "ledger.json";
const entry: PluginMove = {
  at: "2026-11-04T00:00:00.000Z",
  from: asPluginId("a"),
  to: asPluginId("b"),
};
const touched = { [pluginMoveKey(entry)]: ["x/a.ts", "x/b.ts", "bun.lock"] };

describe("parsePorcelainZ", () => {
  test("names both sides of a rename and every other entry", () => {
    const out = "R  new/f.ts\0old/f.ts\0 M bun.lock\0?? added.ts\0";
    expect(parsePorcelainZ(out)).toEqual([
      "new/f.ts",
      "old/f.ts",
      "bun.lock",
      "added.ts",
    ]);
  });
});

describe("judgeDirt", () => {
  const base = { uncommitted: [entry], touched, always: [LEDGER] };

  test("a clean tree is clean", () => {
    expect(judgeDirt({ ...base, dirty: [] })).toEqual({ kind: "clean" });
  });

  test("dirt that is all an earlier move's chains", () => {
    expect(
      judgeDirt({ ...base, dirty: ["x/a.ts", "bun.lock", LEDGER] }),
    ).toEqual({ kind: "chained", moves: [entry] });
  });

  test("an unrelated edit blocks, and is the one named", () => {
    expect(judgeDirt({ ...base, dirty: ["x/a.ts", "y.ts"] })).toEqual({
      kind: "unexplained",
      paths: ["y.ts"],
    });
  });

  test("with no uncommitted move, any dirt blocks", () => {
    expect(judgeDirt({ ...base, uncommitted: [], dirty: [LEDGER] })).toEqual({
      kind: "unexplained",
      paths: [LEDGER],
    });
  });
});
