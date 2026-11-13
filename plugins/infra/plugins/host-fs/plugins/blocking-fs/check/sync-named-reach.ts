import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  loadExemptions,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import { fileSetRuntimeReach } from "@plugins/plugin-meta/plugins/plugin-records/core";

const SYNC_NAMED = "blocking-fs/sync-named";

/** A module under a backend folder (`server/`, `machine/`, `central/`, `deps/`), at any depth. */
const BACKEND_MODULE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/(?:server|machine|central|deps)\/.+\.tsx?$/;

/** What the check reads of one run, injected so it is testable on a fixture. */
export interface SyncNamedReachScan {
  /** Every repo path in the run. */
  paths: readonly string[];
  /**
   * Every repo module `entries` load at runtime (dynamic imports followed),
   * each mapped to the module that first reached it (null for an entry) — the
   * module graph's file records (`fileSetRuntimeReach`), never a parse of its own.
   */
  reach: (entries: readonly string[]) => Promise<Map<string, string | null>>;
  /** The `blocking-fs/sync-named` exemptions declared in the run. */
  exemptions: readonly ResolvedExemption[];
}

export interface SyncNamedReachViolation {
  /** The exempted module a backend loads. */
  module: string;
  exemption: ResolvedExemption;
  /** The import chain from a backend module to it. */
  chain: string[];
}

/** The backend modules a run holds: its runtime code, test code excluded. */
export function backendModules(paths: readonly string[]): string[] {
  return paths
    .filter((p) => BACKEND_MODULE.test(p) && !isTestCodePath(p.split("/")))
    .sort();
}

/**
 * Every module a `sanctioned` `blocking-fs/sync-named` exemption covers that
 * a backend loads anyway. Such an exemption claims "no backend runs this":
 * the helper blocks its thread but serves only the CLI, checks and scripts,
 * so it need not carry the `*Sync` name `blocking-fs/no-sync-fs` reads. The
 * claim is a fact of the backends' import graph, read off the module graph
 * (`fileSetRuntimeReach` from every backend module).
 * A `debt` exemption makes no such claim — it is a helper a backend does
 * reach, not yet renamed, and names its task.
 */
export async function syncNamedReachViolations(
  scan: SyncNamedReachScan,
): Promise<SyncNamedReachViolation[]> {
  const sanctioned = scan.exemptions.filter(
    (e) => e.rule === SYNC_NAMED && e.kind === "sanctioned",
  );
  if (sanctioned.length === 0) return [];
  const parent = await scan.reach(backendModules(scan.paths));
  const violations: SyncNamedReachViolation[] = [];
  for (const module of [...parent.keys()].sort()) {
    const exemption = sanctioned.find(
      (e) => module === e.target || module.startsWith(`${e.target}/`),
    );
    if (exemption === undefined) continue;
    const chain = [module];
    for (
      let m = parent.get(module);
      m !== null && m !== undefined;
      m = parent.get(m)
    )
      chain.unshift(m);
    violations.push({ module, exemption, chain });
  }
  return violations;
}

/**
 * A helper excused from `*Sync` naming is really out of every backend's
 * reach. `blocking-fs/sync-named` is a per-file lint, so it cannot tell a
 * `core/` file only the CLI loads from one a backend loads; a plugin whose
 * blocking helpers serve only host tools (codegen, checks, the build) says so
 * with a `sanctioned` exemption, and this check holds it to it.
 */
export const syncNamedReachCheck: Check = {
  id: "blocking-fs:sync-named-reach",
  description:
    "no backend (server/, machine/, central/, deps/ — dynamic imports followed) loads a module a sanctioned blocking-fs/sync-named exemption covers: a blocking helper is excused from its *Sync name only while no backend can call it",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const violations = await syncNamedReachViolations({
      paths: repo.all(),
      reach: (entries) => fileSetRuntimeReach(repo, entries),
      exemptions: await loadExemptions(repo),
    });
    if (violations.length === 0) return { ok: true };
    return {
      ok: false,
      message: violations
        .map(
          (v) =>
            `${v.module} (sanctioned by ${v.exemption.manifest}) is loaded by a backend: ${v.chain.join(" → ")}`,
        )
        .join("\n  "),
      hint:
        "A backend runs this helper, so its blocking functions must be named *Sync (blocking-fs/sync-named) " +
        "and the backend must call an async twin. Drop the sanctioned exemption and rename, or cut the import.",
    };
  },
};
