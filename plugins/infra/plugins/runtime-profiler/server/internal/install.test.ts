// The boot wiring, end to end: importing install.ts installs the ambient loader
// entry AND hands every loader's captured tables to server-core's runtime-owned
// read-set — the per-run capture the runtime's drift guard judges. Neither the
// profiler's kill-switch nor a profile reset may blind it.
import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import {
  defineResource,
  loadResourceByKey,
  setRelationBases,
} from "@plugins/framework/plugins/server-core/core";
import {
  clearRelationBases,
  getReadSetIndex,
} from "@plugins/framework/plugins/server-core/core/testing";
import { mintReachPlan } from "@plugins/framework/plugins/resource-runtime/core";
import "./install";
import {
  recordEntrySpan,
  recordReadTables,
  resetRuntimeProfile,
} from "../../core";

// The relation bases this file installs are process-global: reset them.
afterAll(clearRelationBases);

// Run `fn` with the profiler's kill-switch set as given (`"0"` = off, unset =
// on), restoring the prior setting after.
async function withProfiling(
  setting: "0" | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const prior = process.env.SINGULARITY_PROFILING;
  if (setting === undefined) delete process.env.SINGULARITY_PROFILING;
  else process.env.SINGULARITY_PROFILING = setting;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env.SINGULARITY_PROFILING;
    else process.env.SINGULARITY_PROFILING = prior;
  }
}

test("a loader's tables reach the runtime-owned read-set under SINGULARITY_PROFILING=0, and survive a profile reset", async () => {
  await withProfiling("0", async () => {
    await recordEntrySpan("loader", "install-test-resource", async () => {
      await Promise.resolve(); // across an await, like a real DB read
      recordReadTables(["install_test_table"]);
    });
  });
  expect(getReadSetIndex()["install-test-resource"]).toEqual([
    "install_test_table",
  ]);

  resetRuntimeProfile();
  expect(getReadSetIndex()["install-test-resource"]).toEqual([
    "install_test_table",
  ]);
});

// A non-keyed routed value (the `reach` arm): one full route on its table.
function routedValue(key: string, reads: string[]): void {
  defineResource(
    { key, schema: z.number(), validateParams: () => {} },
    {
      mode: "push",
      reach: mintReachPlan({
        routes: [
          {
            id: "base",
            table: "install_reach_table",
            map: { kind: "full", reason: "test" },
            columns: [],
          },
        ],
        usesOf: () => new Map([["base", { role: "membership" as const }]]),
      }),
      loader: async () => {
        await Promise.resolve(); // across an await, like a real DB read
        recordReadTables(reads);
        return 1;
      },
    },
  );
}

// The capture reaches the runtime through the loader entry `wrapLoad` opens —
// with the profiler on (production's setting) and under its kill-switch alike —
// and server-core turns the guard strict under a test runner.
for (const [label, profiling, setting] of [
  ["profiling on", "on", undefined],
  ["SINGULARITY_PROFILING=0", "off", "0"],
] as const) {
  test(`A8 under the real wiring (${label}): a routed loader reading a table no route names fails its load in a test run`, async () => {
    const ok = `install-test-reach-ok-${profiling}`;
    const drift = `install-test-reach-drift-${profiling}`;
    routedValue(ok, ["install_reach_table"]);
    routedValue(drift, ["install_reach_table", "install_stray_table"]);
    // No views here: every relation is its own base (change-feed sets the
    // real ones at boot); the drift guard expands a capture through them.
    setRelationBases((r) => [r]);
    await withProfiling(setting, async () => {
      expect(await loadResourceByKey(ok)).toBe(1);
      const failure = await loadResourceByKey(drift).then(
        () => null,
        (err: unknown) => err,
      );
      expect(String(failure)).toMatch(
        /read "install_stray_table", which none of its routes names/,
      );
    });
  });
}
