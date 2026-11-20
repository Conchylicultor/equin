import { describe, expect, test } from "bun:test";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { assemblePluginTree, type PluginFields } from "./plugin-tree";

const ROOT = asAppPath("/repo/plugins");

function fields(flags: { collapsed?: boolean; expanded?: boolean } = {}) {
  return {
    descriptions: {},
    loadBearing: false,
    collapsed: flags.collapsed ?? false,
    expanded: flags.expanded ?? false,
    compositionRoot: false,
    runtimes: { web: true, server: false, machine: false, central: false },
  } satisfies PluginFields;
}

function collapsedOf(
  plugins: Record<string, { collapsed?: boolean; expanded?: boolean }>,
): Record<string, boolean> {
  const t = assemblePluginTree(
    ROOT,
    Object.entries(plugins).map(([p, f]) => [p, fields(f)] as const),
  );
  return Object.fromEntries(
    [...t.byPath.values()].map((n) => [n.path, n.collapsed]),
  );
}

describe("compact-index collapse", () => {
  test("a top-level plugin lists its children; a nested branch is folded; a leaf never is", () => {
    expect(
      collapsedOf({
        a: {},
        "a/plugins/b": {},
        "a/plugins/b/plugins/c": {},
        "a/plugins/d": {},
        e: {},
      }),
    ).toEqual({
      a: false,
      "a/plugins/b": true,
      "a/plugins/b/plugins/c": false,
      "a/plugins/d": false,
      e: false,
    });
  });

  test("`collapsed` folds a top-level plugin; `expanded` lists a nested one", () => {
    expect(
      collapsedOf({
        a: { collapsed: true },
        "a/plugins/b": {},
        x: {},
        "x/plugins/y": { expanded: true },
        "x/plugins/y/plugins/z": {},
        "x/plugins/y/plugins/z/plugins/w": {},
      }),
    ).toEqual({
      a: true,
      "a/plugins/b": false,
      x: false,
      "x/plugins/y": false,
      "x/plugins/y/plugins/z": true,
      "x/plugins/y/plugins/z/plugins/w": false,
    });
  });

  test("a flag that changes nothing where it sits throws, naming the plugin", () => {
    expect(() =>
      collapsedOf({ a: {}, "a/plugins/b": { collapsed: true } }),
    ).toThrow(/plugins\/a\/plugins\/b: `collapsed: true` on a nested plugin/);
    expect(() => collapsedOf({ a: { expanded: true } })).toThrow(
      /plugins\/a: `expanded: true` on a top-level plugin/,
    );
  });
});
