// Loading the check registry: every `plugins/<p>/check/index.ts` the build
// discovered (`check.generated.ts`), validated, each check paired with the
// module its code lives in.
//
// Kept OUT of checks/core on purpose (see this plugin's CLAUDE.md): an
// input-keyed check's code key covers its module's whole closure, literal
// `import()`s included, and the registry's `import()` below reaches every
// check — so neither the runner nor any check may reach this module. The
// `check` command loads the registry and hands it to `runChecks`.

import { loadCollectedDirEntries } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  assertExemptableInvariant,
  scopeOf,
  type LoadedCheck,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";

function isCheck(value: unknown): value is Check {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Check).id === "string" &&
    typeof (value as Check).description === "string" &&
    typeof (value as Check).run === "function"
  );
}

/**
 * Enforce the `Check.scope` invariant at LOAD, not at run: a non-tree check's
 * subject is outside the tree hash, so without a `cacheSignature()` the runner
 * would record its verdict under a tree-only key and replay that pass for every
 * later state of that subject — a green that can never go red again. Throwing
 * here fires for `runChecks` and `--list` alike, so the violation surfaces the
 * moment the check is written rather than as an inexplicably-passing check
 * months later.
 *
 * Written as "anything but `tree`" rather than as a list of the scopes that owe
 * a signature. The condition used to be `=== "deploy"`, which was the same set
 * while `deploy` was the only non-tree scope — and would have silently exempted
 * `host` the moment it was added, which is exactly the class of hole this
 * assertion exists to close.
 */
function assertScopeInvariant(checks: Check[]): void {
  for (const check of checks) {
    const scope = scopeOf(check);
    // `alwaysRun` means "run even under `build --skip-checks`" — it is defined
    // entirely in terms of the ops (build, push) that a `host` verdict is not
    // theirs to assert. The pair is a contradiction, so it has no spelling
    // rather than being quietly filtered out at each call site.
    if (scope === "host" && check.alwaysRun === true) {
      throw new Error(
        `Check "${check.id}" is scope: "host" and alwaysRun: true, which cannot both hold. ` +
          `alwaysRun means "run during a build even with --skip-checks", and a build cannot ` +
          `assert a host-scoped verdict: its subject is the machine, shared with every other ` +
          `checkout on this box and ahead of any one branch. Drop alwaysRun, or reclassify ` +
          `the check if its subject really is this tree or this build's deploy.`,
      );
    }
    if (scope !== "tree" && check.cacheSignature === undefined) {
      throw new Error(
        `Check "${check.id}" is scope: "${scope}" but supplies no cacheSignature(). ` +
          `A ${scope}-scoped verdict is not covered by the working-tree hash, so caching it ` +
          `under the tree hash alone would record a permanently stale pass. Add a ` +
          `cacheSignature() that covers the ${scope} state it inspects (or returns null to ` +
          `opt out of caching entirely).`,
      );
    }
  }
}

/** Every registered check, each with its module. */
export async function loadChecks(): Promise<LoadedCheck[]> {
  const { checkEntries } = await import("./check.generated");
  // `strict`: a check whose module fails to load (or exports no check) is not
  // a check that passed — skipped with a warning, it would read as green.
  // A registry line whose `check/` was deleted fails here too (naming it)
  // until `./equin build` regenerates the registry, which a build does before
  // it checks.
  const loaded = await loadCollectedDirEntries<Check>(checkEntries, {
    isItem: isCheck,
    dedupeKey: (c) => c.id,
    label: "check",
    strict: true,
  });
  const checks = loaded.map((l) => l.item);
  assertScopeInvariant(checks);
  assertExemptableInvariant(checks);
  // The registry's loader is `import("@plugins/<pluginPath>/check")`, which
  // resolves to the barrel's index.ts (the `check` folder is a leaf folder of
  // exactly that shape). The code key's module graph throws when it does not
  // exist, so a registry of another shape fails loudly, never keys on nothing.
  return loaded.map(({ item, entry }) => ({
    check: item,
    module: `plugins/${entry.pluginPath}/check/index.ts`,
  }));
}

export async function listAllChecks(): Promise<Check[]> {
  return (await loadChecks()).map((l) => l.check);
}
