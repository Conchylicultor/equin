import { describe, expect, it } from "bun:test";
import { asPluginId, type PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { Edge, EdgeGraph } from "@plugins/plugin-meta/plugins/closure/core";
import { buildDepTree } from "./build-dep-tree";

const id = (s: string): PluginId => asPluginId(s);

/**
 * Builds an EdgeGraph from a forward-edge spec. Every node listed becomes a key
 * in all four maps (default []), mirroring the real graph's invariant. Reverse
 * maps are derived from the forward spec.
 */
function makeGraph(spec: {
  nodes: string[];
  hard?: [string, string][];
  soft?: [string, string][];
}): EdgeGraph {
  const empty = (): Map<PluginId, PluginId[]> => {
    const m = new Map<PluginId, PluginId[]>();
    for (const n of spec.nodes) m.set(id(n), []);
    return m;
  };
  const hardForward = empty();
  const hardReverse = empty();
  const softForward = empty();
  const softReverse = empty();
  const subtree = empty();
  const edges: Edge[] = [];

  for (const [from, to] of spec.hard ?? []) {
    hardForward.get(id(from))!.push(id(to));
    hardReverse.get(id(to))!.push(id(from));
    edges.push({ from: id(from), to: id(to), kind: "hard" });
  }
  for (const [from, to] of spec.soft ?? []) {
    softForward.get(id(from))!.push(id(to));
    softReverse.get(id(to))!.push(id(from));
    edges.push({ from: id(from), to: id(to), kind: "soft" });
  }

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

describe("buildDepTree", () => {
  it("dedupes a diamond into one expandable + one duplicate leaf", () => {
    // A → B, A → C, B → D, C → D
    const graph = makeGraph({
      nodes: ["A", "B", "C", "D"],
      hard: [
        ["A", "B"],
        ["A", "C"],
        ["B", "D"],
        ["C", "D"],
      ],
    });

    const tree = buildDepTree(graph, id("A"), "deps");

    // total = distinct closure size (B, C, D) excluding root A.
    expect(tree.total).toBe(3);
    expect(tree.roots.map((r) => String(r.id))).toEqual(["B", "C"]);

    const b = tree.roots[0]!;
    const c = tree.roots[1]!;

    // First occurrence of D (under B) expands; second occurrence (under C) is a duplicate leaf.
    expect(b.children).toHaveLength(1);
    const dUnderB = b.children[0]!;
    expect(String(dUnderB.id)).toBe("D");
    expect(dUnderB.duplicate).toBe(false);

    expect(c.children).toHaveLength(1);
    const dUnderC = c.children[0]!;
    expect(String(dUnderC.id)).toBe("D");
    expect(dUnderC.duplicate).toBe(true);
    expect(dUnderC.children).toEqual([]);
  });

  it("returns empty roots and total 0 for a node with no deps", () => {
    const graph = makeGraph({ nodes: ["A", "B"], hard: [["B", "A"]] });
    const tree = buildDepTree(graph, id("A"), "deps");
    expect(tree.roots).toEqual([]);
    expect(tree.total).toBe(0);
  });

  it("walks reverse edges for the dependents direction", () => {
    // B → A and C → A (hard) ⇒ A is used by B and C.
    const graph = makeGraph({
      nodes: ["A", "B", "C"],
      hard: [
        ["B", "A"],
        ["C", "A"],
      ],
    });
    const tree = buildDepTree(graph, id("A"), "dependents");
    expect(tree.total).toBe(2);
    expect(tree.roots.map((r) => String(r.id)).sort()).toEqual(["B", "C"]);
  });

  it("tags soft edges with kind \"soft\"", () => {
    const graph = makeGraph({
      nodes: ["A", "B"],
      soft: [["A", "B"]],
    });
    const tree = buildDepTree(graph, id("A"), "deps");
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.kind).toBe("soft");
  });

  it("keeps the hard occurrence when a child is reachable both hard and soft", () => {
    const graph = makeGraph({
      nodes: ["A", "B"],
      hard: [["A", "B"]],
      soft: [["A", "B"]],
    });
    const tree = buildDepTree(graph, id("A"), "deps");
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.kind).toBe("hard");
  });
});
