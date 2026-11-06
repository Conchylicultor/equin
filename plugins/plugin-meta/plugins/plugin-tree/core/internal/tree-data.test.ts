import { describe, expect, test } from "bun:test";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { assemblePluginTree, type PluginFields } from "./plugin-tree";
import {
  pluginTreeDelta,
  pluginTreeFromDelta,
  pluginTreeToJson,
} from "./tree-data";

const ROOT = asAppPath("/repo/plugins");

function fields(description: string): PluginFields {
  return {
    description,
    descriptions: {},
    loadBearing: false,
    collapsed: false,
    compositionRoot: false,
    runtimes: { web: true, server: false, machine: false, central: false },
  };
}

function tree(facets: Record<string, Record<string, unknown>>) {
  const t = assemblePluginTree(
    ROOT,
    Object.keys(facets).map((p) => [p, fields(p)] as const),
  );
  for (const [p, f] of Object.entries(facets)) t.byPath.get(p)!.facets = f;
  return t;
}

describe("plugin tree delta", () => {
  test("a first delta carries every node; a later one only the changed, and reads back whole", () => {
    const sent = new Map<string, string>();
    const a = tree({ a: { x: 1 }, "a/plugins/b": { x: 2 }, c: { x: 3 } });
    const first = pluginTreeDelta(a, sent);
    expect(first.changed).toBe(3);
    const readA = pluginTreeFromDelta(ROOT, first.delta, null);
    expect(pluginTreeToJson(readA)).toEqual(pluginTreeToJson(a));

    const b = tree({ a: { x: 1 }, "a/plugins/b": { x: 9 } });
    const second = pluginTreeDelta(b, sent);
    expect(second.changed).toBe(1);
    expect(second.delta.roots[0]!.facets).toBeNull();
    expect([...sent.keys()].sort()).toEqual(["a", "a/plugins/b"]);
    const readB = pluginTreeFromDelta(ROOT, second.delta, readA);
    expect(pluginTreeToJson(readB)).toEqual(pluginTreeToJson(b));
    // Unchanged facets are the reader's own objects, not parsed again.
    expect(readB.byPath.get("a")!.facets).toBe(readA.byPath.get("a")!.facets);
  });

  test("a delta naming a node unchanged that the reader never held throws", () => {
    const sent = new Map<string, string>();
    pluginTreeDelta(tree({ a: { x: 1 } }), sent);
    const { delta } = pluginTreeDelta(tree({ a: { x: 1 } }), sent);
    expect(() => pluginTreeFromDelta(ROOT, delta, null)).toThrow(
      /no earlier tree/,
    );
  });
});
