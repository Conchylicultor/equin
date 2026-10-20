// A check's side of the exempt primitive: `ctx.exempt(id)` / `ctx.inScope(path)`,
// and the after-run verdict on exemptions that suppressed nothing.
//
// One session per check run. Hits are what "unused" is measured against, so a
// session owns its own index: two checks reading the same exemption set never
// share hits.

import type {
  Check,
  CheckContext,
  CheckResult,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import {
  createExemptionIndex,
  describeExemption,
  exemptManifestPaths,
  isInAnyCategory,
  type ExemptionIndex,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";

/**
 * Enforce the shape of `Check.exemptable` at LOAD: every id is the check's own
 * id or `<id>:<sub>`, and none contains `/` — the lint rule namespace
 * (`<ns>/<rule>`), so an exemption's rule id says by its spelling which
 * mechanism owns it.
 */
export function assertExemptableInvariant(checks: readonly Check[]): void {
  for (const check of checks) {
    for (const id of Object.keys(check.exemptable ?? {})) {
      if (id.includes("/")) {
        throw new Error(
          `Check "${check.id}" declares exemptable id "${id}" containing "/", which spells a lint rule id. Use "${check.id}" or "${check.id}:<sub>".`,
        );
      }
      if (id !== check.id && !id.startsWith(`${check.id}:`)) {
        throw new Error(
          `Check "${check.id}" declares exemptable id "${id}", which is outside its namespace. Use "${check.id}" or "${check.id}:<sub>", so the id names its owner.`,
        );
      }
    }
  }
}

export interface CheckExemptionSession {
  /** The two context members this session backs. */
  ctx: Pick<CheckContext, "exempt" | "inScope">;
  /** The check's result, failed for every exemption of its ids that matched nothing. */
  finish(result: CheckResult): Promise<CheckResult>;
}

/**
 * Open the session for one run of `check`. `repo` is the context's own
 * `repo()` — the RECORDING one for an input-keyed check — and `load` the
 * run's memoized exemption load.
 *
 * The manifests are listed and read through `repo`
 * before the index is built: the loaded VALUES come from the module loader,
 * but listing and reading them here is what puts their set and bytes in the
 * check's read-set, so adding, removing or editing a manifest invalidates a
 * cached PASS.
 */
export function openCheckExemptions(
  check: Check,
  repo: () => Promise<RepoFiles>,
  load: () => Promise<readonly ResolvedExemption[]>,
): CheckExemptionSession {
  const exemptable = check.exemptable ?? {};
  const outOfScope = check.outOfScope ?? [];
  let index: Promise<ExemptionIndex> | null = null;
  const ensure = (): Promise<ExemptionIndex> =>
    (index ??= (async () => {
      const files = await repo();
      await Promise.all(exemptManifestPaths(files).map((p) => files.read(p)));
      const all = await load();
      return createExemptionIndex(all.filter((e) => e.rule in exemptable));
    })());
  const inScope = (path: string): boolean => !isInAnyCategory(path, outOfScope);

  return {
    ctx: {
      inScope,
      async exempt(id) {
        if (!(id in exemptable)) {
          throw new Error(
            `Check "${check.id}" asked for exemptions of "${id}", which it does not declare in \`exemptable\`` +
              ` (declared: ${Object.keys(exemptable).join(", ") || "none"}).`,
          );
        }
        const matcher = (await ensure()).exemptionsFor(id);
        return {
          skips: (path) => !inScope(path) || matcher.match(path) !== undefined,
          match: (path) => matcher.match(path),
        };
      },
    },
    async finish(result) {
      if (check.exemptable === undefined) return result;
      // An inconclusive run did not scan; it cannot judge what went unused.
      if (!result.ok && result.inconclusive) return result;
      const unused = (await ensure()).unused();
      if (unused.length === 0) return result;
      const detail =
        `${unused.length} exemption(s) of ${check.id} suppressed nothing — delete them:\n    ` +
        unused.map(describeExemption).join("\n    ");
      return result.ok
        ? {
            ok: false,
            message: detail,
            hint: "An exemption that matches no violation is dead: the file was fixed, moved, or never violated the rule. Remove the entry from the named exempt/index.ts.",
          }
        : { ...result, message: `${result.message}\n${detail}` };
    },
  };
}
