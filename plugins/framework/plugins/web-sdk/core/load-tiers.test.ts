import { describe, expect, test } from "bun:test";
import { isDeferredPluginPath, partitionWebEntries } from "./load-tiers";
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
