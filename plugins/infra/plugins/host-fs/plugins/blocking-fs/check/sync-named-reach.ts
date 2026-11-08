import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  loadExemptions,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import {
  loadsAtRuntime,
  resolveRepoModule,
} from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import { maskedSource } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { findImports } from "@plugins/plugin-meta/plugins/parse-utils/core";

const SYNC_NAMED = "blocking-fs/sync-named";

/** A module under a backend folder (`server/`, `machine/`, `central/`, `deps/`), at any depth. */
const BACKEND_MODULE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/(?:server|machine|central|deps)\/.+\.tsx?$/;

/** What the check reads of one run, injected so it is testable on a fixture. */
export interface SyncNamedReachScan {
  /** Every repo path in the run. */
  paths: readonly string[];
  read: (path: string) => Promise<string | null>;
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
 * claim is a fact of the backends' import graph, measured here
 * (`backendReach`).
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
  const parent = await backendReach(scan);
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

/** A dynamic `import("<literal>")` (or a backtick literal with no interpolation). */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/g;
const DYNAMIC_LITERAL_RE = /\s*(["'`])([^"'`$]+)\1\s*\)/y;

/**
 * The repo modules `src` loads at runtime: its static imports that do not
 * erase, and its literal dynamic `import()`s (a lazy load on a backend still
 * runs on its thread).
 */
async function runtimeSpecifiers(rel: string, src: string): Promise<string[]> {
  // Masked through the check runner's shared time slice: every check shares
  // one thread (check-thread-safety). Masking keeps every offset, so a match
  // in the masked text is read back from the source at the same index.
  const masked = await maskedSource({ rel, src });
  const out = findImports(src, masked)
    .filter(loadsAtRuntime)
    .map((ref) => ref.specifier);
  for (const m of masked.matchAll(DYNAMIC_IMPORT_RE)) {
    DYNAMIC_LITERAL_RE.lastIndex = m.index + m[0].length;
    const lit = DYNAMIC_LITERAL_RE.exec(src);
    if (lit !== null) out.push(lit[2]!);
  }
  return out;
}

/**
 * Every repo module a backend loads, each mapped to the module that first
 * reached it (null for a backend module itself): a breadth-first walk of the
 * runtime import graph from every backend module, read off the tree's text —
 * the same reading `boundaries:web-loads-portable` makes of the browser
 * realm's frontier, without a bundler build (seconds, not a minute).
 */
export async function backendReach(
  scan: Pick<SyncNamedReachScan, "paths" | "read">,
): Promise<Map<string, string | null>> {
  const files = new Set(scan.paths);
  const parent = new Map<string, string | null>();
  let frontier = backendModules(scan.paths);
  for (const m of frontier) parent.set(m, null);
  while (frontier.length > 0) {
    const next: string[] = [];
    await Promise.all(
      frontier.map(async (file) => {
        const src = await scan.read(file);
        if (src === null)
          throw new Error(
            `${file} is in the run's file set but cannot be read.`,
          );
        for (const spec of await runtimeSpecifiers(file, src)) {
          const target = resolveRepoModule(file, spec, (p) => files.has(p));
          if (target === null || parent.has(target)) continue;
          parent.set(target, file);
          next.push(target);
        }
      }),
    );
    frontier = next;
  }
  return parent;
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
      read: (p) => repo.read(p),
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
