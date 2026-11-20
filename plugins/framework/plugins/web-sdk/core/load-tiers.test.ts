import { describe, expect, test } from "bun:test";
import {
  isDeferredPluginPath,
  partitionWebEntries,
  planDeferredLoad,
} from "./load-tiers";
import { DEFERRED_PLUGIN_PATHS } from "./web-tiers.generated";

// These test the lookup's contract, not which plugins happen to be deferred
// today: the derivation's rules (structural, watched slots, preloads, dependsOn
// closure) are tested on synthetic graphs in codegen's `eager-tier-gen.test.ts`,
// and the `eager-tier-in-sync` check keeps the generated set equal to them. A
// test naming real plugins here would only restate the generated file and
// break on every refactor that moves a plugin across tiers.
const deferredPaths = [...DEFERRED_PLUGIN_PATHS];
const UNKNOWN = "no/such/plugin";
const STRUCTURALLY_EAGER = [
  "conversations",
  "primitives/plugins/pane",
] as const;

describe("isDeferredPluginPath (against the generated tier set)", () => {
  test("the generated set is non-empty (app content does defer)", () => {
    expect(deferredPaths.length).toBeGreaterThan(0);
  });

  test("every path in the generated set defers", () => {
    for (const p of deferredPaths) expect(isDeferredPluginPath(p)).toBe(true);
  });

  test("an unknown path is eager (the fail-safe direction)", () => {
    expect(isDeferredPluginPath(UNKNOWN)).toBe(false);
  });

  test("only app content defers: never a non-app plugin nor an app's shell subtree", () => {
    for (const p of deferredPaths) {
      expect(p).toMatch(/^apps\/plugins\/[^/]+\/plugins\/(?!shell(\/|$))/);
    }
    for (const p of STRUCTURALLY_EAGER) {
      expect(isDeferredPluginPath(p)).toBe(false);
    }
  });
});

describe("partitionWebEntries", () => {
  const entries: { pluginPath: string }[] = [
    { pluginPath: STRUCTURALLY_EAGER[0] },
    { pluginPath: deferredPaths[0]! },
    { pluginPath: UNKNOWN },
    { pluginPath: deferredPaths.at(-1)! },
    { pluginPath: STRUCTURALLY_EAGER[1] },
  ];

  test("covers all entries (eager + deferred === input)", () => {
    const { eager, deferred } = partitionWebEntries(entries);
    expect(eager.length + deferred.length).toBe(entries.length);
  });

  test("splits by isDeferredPluginPath, preserving input order within each tier", () => {
    const { eager, deferred } = partitionWebEntries(entries);
    expect(eager).toEqual(
      entries.filter((e) => !isDeferredPluginPath(e.pluginPath)),
    );
    expect(deferred).toEqual(
      entries.filter((e) => isDeferredPluginPath(e.pluginPath)),
    );
    expect(eager.map((e) => e.pluginPath)).toEqual([
      STRUCTURALLY_EAGER[0],
      UNKNOWN,
      STRUCTURALLY_EAGER[1],
    ]);
  });
});

describe("planDeferredLoad", () => {
  const e = (pluginPath: string, dependsOn: string[] = []) => ({
    pluginPath,
    dependsOn,
  });
  const paths = (xs: { pluginPath: string }[]) => xs.map((x) => x.pluginPath);

  test("a dependency registers in the same batch or an earlier one, never later", () => {
    // The Sonata shape: the engine (alphabetically first) depends on the
    // mixer, which depends on the plugin registering the config it reads.
    const deferred = [
      e("apps/plugins/a/plugins/engine", ["apps/plugins/a/plugins/mixer"]),
      e("apps/plugins/a/plugins/filler-1"),
      e("apps/plugins/a/plugins/look", ["eager/plugin"]),
      e("apps/plugins/a/plugins/mixer", ["apps/plugins/a/plugins/look"]),
    ];
    const { priority, rest } = planDeferredLoad(deferred, null, 1);
    expect(priority).toEqual([]);
    expect(rest.map(paths)).toEqual([
      ["apps/plugins/a/plugins/look"],
      ["apps/plugins/a/plugins/mixer"],
      ["apps/plugins/a/plugins/engine"],
      ["apps/plugins/a/plugins/filler-1"],
    ]);
  });

  test("priority holds the active app's content plus every deferred plugin it depends on", () => {
    const deferred = [
      e("apps/plugins/a/plugins/x"),
      e("apps/plugins/b/plugins/view", ["apps/plugins/a/plugins/y"]),
      e("apps/plugins/a/plugins/y"),
      e("apps/plugins/b/plugins/other"),
    ];
    const { priority, rest } = planDeferredLoad(
      deferred,
      "apps/plugins/b/",
      24,
    );
    expect(paths(priority)).toEqual([
      "apps/plugins/a/plugins/y",
      "apps/plugins/b/plugins/view",
      "apps/plugins/b/plugins/other",
    ]);
    expect(rest.map(paths)).toEqual([["apps/plugins/a/plugins/x"]]);
  });

  test("every entry is planned exactly once, input order kept among independent ones", () => {
    const deferred = Array.from({ length: 50 }, (_, i) =>
      e(`apps/plugins/a/plugins/p${i}`),
    );
    const { priority, rest } = planDeferredLoad(deferred, null, 24);
    expect(priority).toEqual([]);
    expect(rest.map((b) => b.length)).toEqual([24, 24, 2]);
    expect(rest.flat()).toEqual(deferred);
  });

  test("a dependsOn cycle throws with its path", () => {
    const deferred = [e("a", ["b"]), e("b", ["a"])];
    expect(() => planDeferredLoad(deferred, null, 24)).toThrow(
      /cycle: a → b → a/,
    );
  });
});
