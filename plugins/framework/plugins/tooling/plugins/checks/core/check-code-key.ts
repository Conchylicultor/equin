// The code half of an input-keyed check's cache key.
//
// A recorded read-set says which TREE facts a PASS depended on; replaying it
// proves the tree side unchanged. The other input of the verdict is the code
// that computed it: the check's own module and everything it loads, and the
// runner that builds its context and interprets its read-set. A PASS must not
// survive an edit to either.
//
// That code is named by its import closure, never by a list of paths: the key
// is the plugin-records module graph's Merkle key of the check's module and of
// the runner's (a module's blob plus the keys of every module it imports,
// statically or by literal `import()`), plus the npm code those closures load
// (`npmCodeKey`: the lockfile closure of the packages they import by name). It
// moves exactly when code the check can run moves — a check living outside
// `tooling/`, or a helper it imports from anywhere in the repo, included — and
// an edit no check loads leaves every key, and so every replay, alone.
//
// Not covered, as for any module-graph key: an `import()` whose path is not a
// literal, and a file a module reads at run time. Both are reads the check
// makes, so they belong in its read-set (through `ctx.repo()`), not here.

import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import {
  buildModuleGraph,
  codeCheckoutOf,
  currentRecordStore,
  npmCodeKey,
  outsideFilesOf,
  recordKey,
} from "@plugins/plugin-meta/plugins/plugin-records/core";

/** The identity of the code an input-keyed check's verdict is a function of. */
export type CheckCodeKey = string & { readonly __brand: "CheckCodeKey" };

/**
 * Code keys for a run over `repo` (the run's file set): `(checkModule) → key`,
 * for a check whose code enters at `checkModule`, run by the runner module at
 * `runnerUrl` (its `import.meta.url`). One module graph per run, grown as
 * checks ask, each key memoized.
 *
 * The code is read from the checkout the runner lives in (`codeCheckoutOf`) —
 * `repo` itself when the run checks its own checkout (the build's written
 * overlay included), this process's checkout otherwise — never assumed to be
 * the set being checked. `checkModule` (and `checkModules`) are repo-relative
 * in THAT checkout: the checks this process loaded from its own registry.
 *
 * `checkModules` is every registered check's module. A key whose closure holds
 * ANOTHER check's module throws: it covers code the check never runs, so every
 * edit of that check re-runs this one — and reaching one check means reaching
 * the registry, which reaches them all (`checks/plugins/registry`).
 */
export function checkCodeKeys(
  repo: RepoSnapshot,
  runnerUrl: string,
  checkModules: ReadonlySet<string>,
): (checkModule: string) => Promise<CheckCodeKey> {
  // One code input for the run: the graph is shared by identity of its parts,
  // so every check's walk grows the same graph. Resolved at the first key
  // asked, so a failure lands on that key's caller.
  let code: ReturnType<typeof codeCheckoutOf> | undefined;
  const keys = new Map<string, Promise<CheckCodeKey>>();
  const compute = async (checkModule: string): Promise<CheckCodeKey> => {
    code ??= codeCheckoutOf(
      {
        snapshot: repo,
        store: currentRecordStore(),
        readOutside: outsideFilesOf(repo),
      },
      runnerUrl,
    );
    const { input, module: runner } = await code;
    const graph = await buildModuleGraph(input, [checkModule, runner]);
    const foreign = [...graph.modules.keys()].filter(
      (m) => m !== checkModule && checkModules.has(m),
    );
    if (foreign.length > 0)
      throw new Error(
        `the code of the check at ${checkModule} (with the runner, ${runner}) loads ` +
          `${foreign.length} other check module(s), e.g. ${foreign.slice(0, 3).join(", ")}: ` +
          `its cached verdict would be keyed on every one of them. Something in its ` +
          `import closure (static or a literal import()) reaches the check registry or ` +
          `another plugin's check/ — import the barrel that holds what you need instead ` +
          `(checks/core, never checks/plugins/registry).`,
      );
    return recordKey(
      "check-code",
      graph.keyOf(checkModule),
      graph.keyOf(runner),
      await npmCodeKey(input.snapshot, graph.packages),
    ) as CheckCodeKey;
  };
  return (checkModule) => {
    let key = keys.get(checkModule);
    if (key === undefined) keys.set(checkModule, (key = compute(checkModule)));
    return key;
  };
}
