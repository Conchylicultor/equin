import { describe, expect, test } from "bun:test";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { EdgeGraph } from "./types";
import { deserializeEdgeGraph, serializeEdgeGraph } from "./serialize";

const id = (s: string) => s as PluginId;

function tinyGraph(): EdgeGraph {
  const a = id("a");
  const b = id("b");
  const c = id("c");
  return {
    hardForward: new Map([
      [a, [b]],
      [b, []],
      [c, []],
    ]),
    hardReverse: new Map([
      [a, []],
      [b, [a]],
      [c, []],
    ]),
    softForward: new Map([
      [a, []],
      [b, []],
      [c, [b]],
    ]),
    softReverse: new Map([
      [a, []],
      [b, [c]],
      [c, []],
    ]),
    subtree: new Map([
      [a, [b, c]],
      [b, []],
      [c, []],
    ]),
    edges: [
      { from: a, to: b, kind: "hard" },
      { from: c, to: b, kind: "soft" },
    ],
    rules: [
      { then: c, owner: a, users: [b], space: "field-type", key: "date" },
    ],
  };
}

describe("serializeEdgeGraph / deserializeEdgeGraph", () => {
  test("round-trips a hand-built graph back to an equal EdgeGraph", () => {
    const graph = tinyGraph();
    const restored = deserializeEdgeGraph(serializeEdgeGraph(graph));

    for (const key of ["hardForward", "hardReverse", "softForward", "softReverse", "subtree"] as const) {
      expect([...restored[key].entries()].sort()).toEqual([...graph[key].entries()].sort());
    }
    expect(restored.edges).toEqual(graph.edges);
    expect(restored.rules).toEqual(graph.rules);
  });

  test("serialized form is JSON-safe (survives JSON stringify/parse)", () => {
    const graph = tinyGraph();
    const wire = JSON.parse(JSON.stringify(serializeEdgeGraph(graph)));
    const restored = deserializeEdgeGraph(wire);
    expect([...restored.hardForward.get("a" as PluginId)!]).toEqual(["b" as PluginId]);
    expect([...restored.subtree.get("a" as PluginId)!]).toEqual(["b", "c"] as PluginId[]);
  });
});
