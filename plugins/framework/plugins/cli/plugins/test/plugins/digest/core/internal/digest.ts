import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { isDomTestPath } from "@plugins/framework/plugins/tooling/plugins/test-layout/core";
import {
  buildModuleGraph,
  NO_OUTSIDE_FILES,
  npmResolutionsKey,
  recordKey,
  type ModuleGraph,
  type RecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";

/**
 * Bump when what a digest means changes without any keyed input changing (a
 * new runner input, a different reading of an existing one). Every harvested
 * verdict under the old version stops matching the checkout's digests: the
 * page reads every file `stale` until a run lands again.
 */
export const TEST_DIGEST_VERSION = "test-digest-1";

/** The bun:test runner's inputs besides a file's own closure. */
export const BUN_RUNNER_CONFIG = "bunfig.toml";
export const BUN_RUNNER_PRELOAD = "test/bun-preload.ts";
/** vitest's: its config and its setup file (each by static closure). */
export const VITEST_RUNNER_ENTRIES = ["vitest.config.ts", "test/setup.ts"];

/** The two test runners (`./equin test` runs both). */
export type TestRunnerName = "bun:test" | "vitest";

/** Which runner runs a test file — the repo's one split (`test-layout`). */
export function runnerOfTestPath(path: string): TestRunnerName {
  return isDomTestPath(path) ? "vitest" : "bun:test";
}

export interface TestDigest {
  runner: TestRunnerName;
  digest: string;
}

/**
 * The key of a set of modules by STATIC closure only: each member's path and
 * blob, plus its unresolved internal specifiers. A Merkle key counts dynamic
 * edges too, and the bun preload's `await import(machine.generated)` would fold
 * ~3.4k modules into every bun digest — so a runner input is keyed by what it
 * loads with it, and what it loads later is a documented blind spot.
 */
function staticClosureKey(
  graph: ModuleGraph,
  entries: readonly string[],
): string {
  const members = [...graph.staticClosureOf(entries)].sort();
  const parts: string[] = [];
  for (const m of members) {
    const node = graph.modules.get(m)!;
    parts.push(m, node.blob, ...node.unresolved.map((u) => `?${u}`));
  }
  return recordKey("static-closure", ...parts);
}

/**
 * Each test file's digest over the checkout `snapshot` describes: one module
 * graph for every file (plugin-records' shared graph: file facts cached by
 * blob in `store`, so overlapping closures cost one walk), then
 *
 *   digest(f) = recordKey(version, runtime, npm resolutions,
 *                         runnerInputsKey(runner(f)), f, graph.keyOf(f))
 *
 * where `runnerInputsKey("bun:test")` is bunfig.toml plus the preload's static
 * closure and `runnerInputsKey("vitest")` the config's and setup file's static
 * closures. `graph.keyOf(f)` is the file's Merkle key — every module it can
 * load, static or dynamic — so the digest moves exactly when code the file
 * can run changed.
 *
 * Blind spots (what a digest cannot see — bounded by re-runs, never by this
 * key): providers the bun preload loads dynamically, `import.meta.glob`,
 * fixtures read from disk, spawned processes, environment variables, the
 * migrations a DB suite applies, the `@composition-web-registry` alias.
 */
export async function testDigests(
  snapshot: RepoSnapshot,
  store: RecordStore,
  files: readonly string[],
): Promise<Map<string, TestDigest>> {
  const runners = new Map(files.map((f) => [f, runnerOfTestPath(f)]));
  const wantsBun = [...runners.values()].includes("bun:test");
  const wantsVitest = [...runners.values()].includes("vitest");
  const runnerEntries = [
    ...(wantsBun ? [BUN_RUNNER_PRELOAD] : []),
    ...(wantsVitest ? VITEST_RUNNER_ENTRIES : []),
  ];
  const graph = await buildModuleGraph(
    { snapshot, store, readOutside: NO_OUTSIDE_FILES },
    [...files, ...runnerEntries],
  );
  const runnerKeys: Partial<Record<TestRunnerName, string>> = {};
  if (wantsBun)
    runnerKeys["bun:test"] = recordKey(
      "bun:test",
      snapshot.has(BUN_RUNNER_CONFIG)
        ? snapshot.blobOf(BUN_RUNNER_CONFIG)
        : "-",
      staticClosureKey(graph, [BUN_RUNNER_PRELOAD]),
    );
  if (wantsVitest)
    runnerKeys.vitest = recordKey(
      "vitest",
      staticClosureKey(graph, VITEST_RUNNER_ENTRIES),
    );
  const npm = await npmResolutionsKey(snapshot);
  const out = new Map<string, TestDigest>();
  for (const [file, runner] of runners) {
    out.set(file, {
      runner,
      digest: recordKey(
        TEST_DIGEST_VERSION,
        store.environment,
        npm,
        runnerKeys[runner]!,
        file,
        graph.keyOf(file),
      ),
    });
  }
  return out;
}
