import { describe, expect, test } from "bun:test";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { Edge, EdgeGraph } from "@plugins/plugin-meta/plugins/closure/core";
import { focusSubgraph } from "./subgraph";

const id = (s: string): PluginId => s as PluginId;

/**
 * Build an EdgeGraph from explicit hard/soft forward edge lists. Reverse maps are
 * derived; every referenced node is a key in all four maps (the engine invariant).
 */
function makeGraph(hard: [string, string][], soft: [string, string][]): EdgeGraph {
  const hardForward = new Map<PluginId, PluginId[]>();
  const hardReverse = new Map<PluginId, PluginId[]>();
  const softForward = new Map<PluginId, PluginId[]>();
  const softReverse = new Map<PluginId, PluginId[]>();
  const subtree = new Map<PluginId, PluginId[]>();
  const edges: Edge[] = [];

  const ensure = (n: PluginId) => {
    for (const m of [hardForward, hardReverse, softForward, softReverse, subtree]) {
      if (!m.has(n)) m.set(n, []);
    }
  };
  const add = (
    fwd: Map<PluginId, PluginId[]>,
    rev: Map<PluginId, PluginId[]>,
    kind: "hard" | "soft",
    pairs: [string, string][],
  ) => {
    for (const [f, t] of pairs) {
      const from = id(f);
      const to = id(t);
      ensure(from);
      ensure(to);
      fwd.get(from)!.push(to);
      rev.get(to)!.push(from);
      edges.push({ from, to, kind });
    }
  };

  add(hardForward, hardReverse, "hard", hard);
  add(softForward, softReverse, "soft", soft);

  return {
    hardForward,
    hardReverse,
    softForward,
    softReverse,
    subtree,
    edges,
    rules: [],
  };
}

describe("focusSubgraph", () => {
  // f → a → b (hard chain), and c → f (a dependent). plus soft edge f ⇢ s.
  const graph = makeGraph(
    [
      ["f", "a"],
      ["a", "b"],
      ["c", "f"],
    ],
    [["f", "s"]],
  );

  test("focus is always included", () => {
    const sub = focusSubgraph(graph, id("f"), { depth: 0, cap: 100 });
    expect(sub.nodeIds).toEqual([id("f")]);
  });

  test("depth is honored", () => {
    // depth 1 from f: forward a, s; reverse c. NOT b (2 hops away).
    const sub = focusSubgraph(graph, id("f"), { depth: 1, cap: 100 });
    const set = new Set(sub.nodeIds);
    expect(set.has(id("f"))).toBe(true);
    expect(set.has(id("a"))).toBe(true);
    expect(set.has(id("s"))).toBe(true);
    expect(set.has(id("c"))).toBe(true);
    expect(set.has(id("b"))).toBe(false);

    // depth 2 reaches b.
    const deep = focusSubgraph(graph, id("f"), { depth: 2, cap: 100 });
    expect(new Set(deep.nodeIds).has(id("b"))).toBe(true);
  });

  test("cap respected nearest-hop-first with correct hiddenCount", () => {
    // depth 2 reaches f,a,s,c,b = 5 nodes. Cap at 3 keeps focus + nearest.
    const sub = focusSubgraph(graph, id("f"), { depth: 2, cap: 3 });
    expect(sub.nodeIds.length).toBe(3);
    expect(sub.nodeIds[0]).toBe(id("f")); // focus first
    expect(sub.hiddenCount).toBe(2);
    // b is 2 hops out → dropped before the 1-hop neighbors.
    expect(new Set(sub.nodeIds).has(id("b"))).toBe(false);
  });

  test("both hard and soft edges present with right kinds, restricted to kept nodes", () => {
    const sub = focusSubgraph(graph, id("f"), { depth: 2, cap: 100 });
    const hardEdge = sub.edges.find((e) => e.from === id("f") && e.to === id("a"));
    const softEdge = sub.edges.find((e) => e.from === id("f") && e.to === id("s"));
    expect(hardEdge?.kind).toBe("hard");
    expect(softEdge?.kind).toBe("soft");

    // Every emitted edge's endpoints are within the kept set.
    const kept = new Set(sub.nodeIds);
    for (const e of sub.edges) {
      expect(kept.has(e.from)).toBe(true);
      expect(kept.has(e.to)).toBe(true);
    }
    // No edge dangles to a hidden node when capped.
    const capped = focusSubgraph(graph, id("f"), { depth: 2, cap: 3 });
    const cappedKept = new Set(capped.nodeIds);
    for (const e of capped.edges) {
      expect(cappedKept.has(e.from)).toBe(true);
      expect(cappedKept.has(e.to)).toBe(true);
    }
  });

  test("direction deps walks forward only; dependents walks reverse only", () => {
    const deps = focusSubgraph(graph, id("f"), { depth: 2, cap: 100, direction: "deps" });
    const depsSet = new Set(deps.nodeIds);
    expect(depsSet.has(id("a"))).toBe(true);
    expect(depsSet.has(id("s"))).toBe(true);
    expect(depsSet.has(id("c"))).toBe(false); // c is a dependent, not a dep

    const dependents = focusSubgraph(graph, id("f"), {
      depth: 2,
      cap: 100,
      direction: "dependents",
    });
    const depSet = new Set(dependents.nodeIds);
    expect(depSet.has(id("c"))).toBe(true);
    expect(depSet.has(id("a"))).toBe(false);
  });
});
