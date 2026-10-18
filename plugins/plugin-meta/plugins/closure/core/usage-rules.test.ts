import { describe, expect, test } from "bun:test";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { EdgeGraph, UsageRule } from "./types";
import { hardClosure, resolveComposition } from "./resolve-composition";

const id = (s: string) => s as PluginId;

/**
 * A hand-built graph: `app` imports `dv` (the data-view primitive) and
 * `dates` (a field-type definer); `cell` is the date cell, a keyed companion
 * of `dv` serving the key `dates` uses. `bare` imports `dv` alone.
 * `grouping` is a second-order rule: it serves a key only `cell` uses.
 */
function graphWith(rules: UsageRule[]): EdgeGraph {
  const ids = ["app", "bare", "dv", "dates", "cell", "grouping"].map(id);
  const forward: Record<string, string[]> = {
    app: ["dv", "dates"],
    bare: ["dv"],
  };
  const hardForward = new Map(ids.map((n) => [n, (forward[n] ?? []).map(id)]));
  const hardReverse = new Map(ids.map((n) => [n, [] as PluginId[]]));
  for (const [from, tos] of hardForward)
    for (const to of tos) hardReverse.get(to)!.push(from);
  const empty = () => new Map(ids.map((n) => [n, [] as PluginId[]]));
  return {
    hardForward,
    hardReverse,
    softForward: empty(),
    softReverse: empty(),
    subtree: empty(),
    edges: [],
    rules,
  };
}

const cellRule: UsageRule = {
  then: id("cell"),
  owner: id("dv"),
  users: [id("dates")],
  space: "field-type",
  key: "date",
};

describe("usage rules", () => {
  test("a rule fires only when its owner AND one of its users are in", () => {
    const g = graphWith([cellRule]);
    expect(hardClosure([id("app")], g).has(id("cell"))).toBe(true);
    // The owner alone: a DataView with no date field carries no date cell.
    expect(hardClosure([id("bare")], g).has(id("cell"))).toBe(false);
    // A user alone: dates with no DataView carry no cell either.
    expect(hardClosure([id("dates")], g).has(id("cell"))).toBe(false);
  });

  test("the closure is a fixpoint: a rule's conclusion can satisfy another", () => {
    const g = graphWith([
      cellRule,
      {
        then: id("grouping"),
        owner: id("dv"),
        users: [id("cell")],
        space: "field-type",
        key: "date",
      },
    ]);
    const out = hardClosure([id("app")], g);
    expect(out.has(id("cell"))).toBe(true);
    expect(out.has(id("grouping"))).toBe(true);
  });

  test("excluding a used companion is reported, with the usage hop that re-added it", () => {
    const g = graphWith([cellRule]);
    const comp = resolveComposition(g, {
      name: "probe",
      entryPoints: ["app", "!cell"],
      selectedContributors: [],
    });
    expect(comp.bundle.has(id("cell"))).toBe(true);
    expect(comp.unsatisfiedExclusions).toHaveLength(1);
    const steps = comp.unsatisfiedExclusions[0]!.path.steps;
    expect(steps.at(-1)).toEqual({
      from: id("dates"),
      to: id("cell"),
      kind: "hard",
      usage: { owner: id("dv"), space: "field-type", key: "date" },
    });
  });
});
