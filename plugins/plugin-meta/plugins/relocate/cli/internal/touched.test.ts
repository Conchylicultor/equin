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
  const base = {
    uncommitted: [entry],
    touched,
    always: [LEDGER],
    newUmbrella: null,
  };

  test("a clean tree is clean", () => {
    expect(judgeDirt({ ...base, dirty: [] })).toEqual({ kind: "clean" });
  });

  test("dirt that is all an earlier move's chains", () => {
    expect(
      judgeDirt({ ...base, dirty: ["x/a.ts", "bun.lock", LEDGER] }),
    ).toEqual({ kind: "chained", moves: [entry], newUmbrella: null });
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

  describe("a brand-new umbrella", () => {
    const fresh = { ...base, uncommitted: [], newUmbrella: "new/u" };

    test("its package.json and CLAUDE.md alone are accepted", () => {
      expect(
        judgeDirt({
          ...fresh,
          dirty: ["new/u/package.json", "new/u/CLAUDE.md"],
        }),
      ).toEqual({ kind: "chained", moves: [], newUmbrella: "new/u" });
    });

    test("the lockfile its install rewrote rides with it", () => {
      expect(
        judgeDirt({ ...fresh, dirty: ["new/u/package.json", "bun.lock"] }),
      ).toEqual({ kind: "chained", moves: [], newUmbrella: "new/u" });
    });

    test("the lockfile alone, with no umbrella file dirty, blocks", () => {
      expect(judgeDirt({ ...fresh, dirty: ["bun.lock"] })).toEqual({
        kind: "unexplained",
        paths: ["bun.lock"],
      });
    });

    test("anything else in it blocks, and is the one named", () => {
      expect(
        judgeDirt({
          ...fresh,
          dirty: ["new/u/package.json", "new/u/web/index.ts"],
        }),
      ).toEqual({ kind: "unexplained", paths: ["new/u/web/index.ts"] });
    });

    test("any other dirt still blocks", () => {
      expect(
        judgeDirt({ ...fresh, dirty: ["new/u/package.json", "y.ts"] }),
      ).toEqual({ kind: "unexplained", paths: ["y.ts"] });
    });

    test("not new (null): its files are ordinary dirt", () => {
      expect(
        judgeDirt({
          ...fresh,
          newUmbrella: null,
          dirty: ["new/u/package.json"],
        }),
      ).toEqual({ kind: "unexplained", paths: ["new/u/package.json"] });
    });

    test("chains after an earlier move", () => {
      expect(
        judgeDirt({
          ...base,
          newUmbrella: "new/u",
          dirty: ["x/a.ts", "new/u/CLAUDE.md"],
        }),
      ).toEqual({ kind: "chained", moves: [entry], newUmbrella: "new/u" });
    });
  });
});
