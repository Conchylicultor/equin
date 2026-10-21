import type { Check } from "@plugins/framework/plugins/tooling/core";
import { importClosure } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

const WORKER_ENTRY =
  "plugins/debug/plugins/sentinel/server/internal/worker/entry.ts";

/**
 * Subtrees the sentinel worker's static closure may never reach. Each one runs
 * work at module load that needs a plugin runtime the worker thread does not
 * have: config_v2's server half registers its live values and host services
 * and its machine half reads the process namespace to find its config dir, the
 * jobs and database server barrels build the pool and job queue, and
 * server-core is the plugin runtime itself.
 */
// eslint-disable-next-line exempt/no-path-allowlist -- a deny-list of import-closure targets, not an allowlist of violators
const FORBIDDEN_PREFIXES = [
  "plugins/config_v2/server/",
  "plugins/config_v2/machine/",
  "plugins/infra/plugins/jobs/server/",
  "plugins/database/server/",
  "plugins/framework/plugins/server-core/",
];

/**
 * The sentinel worker (`server/internal/worker/entry.ts`) runs on its own Bun
 * thread so it keeps ticking — and keeps renewing the duress latch — while
 * main's event loop is wedged. A thread has no plugin runtime: nothing declares
 * its namespace, loads config, or opens the pool. So every module it loads must
 * be safe to evaluate bare.
 *
 * One convenience import broke that before: `worker/sample.ts` took two zod
 * schemas from health-monitor's SERVER barrel, which pulled in config_v2's
 * server side and the job queue (466 modules), and the worker died at load
 * reading a namespace nobody declared. This check makes the lean closure a
 * measured fact rather than a sentence in the CLAUDE.md.
 *
 * Measured with dynamic imports cut: the subject is what evaluates before the
 * worker's first statement. The failure prints the shortest import chain to the
 * first offending module under each forbidden prefix.
 */
const workerClosureLeanCheck: Check = {
  id: "sentinel:worker-closure-lean",
  description:
    "the sentinel worker's static import closure reaches no config_v2/server or config_v2/machine, jobs/server, database/server or server-core module — the worker thread has no plugin runtime to evaluate them in",
  async run() {
    const found = await findForbiddenModules(WORKER_ENTRY, FORBIDDEN_PREFIXES);
    if (found === null) return { ok: true };
    return {
      ok: false,
      message: found,
      hint:
        "Import what the worker needs from a leaf `core` barrel instead of a `server` barrel (move the " +
        "value into the owning plugin's core/ if it only lives in server/ or shared/). A server barrel " +
        "evaluates its plugin's whole server side, and the worker thread has no namespace, config or " +
        "pool for it to run against.",
    };
  },
};

// eslint-disable-next-line exempt/no-path-allowlist -- the entry points whose closure is checked, not an allowlist of violators
const STATUS_FILE_ENTRIES = [
  "plugins/debug/plugins/sentinel/plugins/status-file/core/index.ts",
  "plugins/debug/plugins/sentinel/plugins/status-file/server/index.ts",
];

/**
 * What the status-file leaf may never load. The build CLI's admission valve
 * imports it, and a CLI process has no backend runtime: config_v2 and
 * live-state belong to a backend, and the parent sentinel's own barrels drag
 * both (its core holds the sentinel config and the live resource).
 */
// eslint-disable-next-line exempt/no-path-allowlist -- a deny-list of import-closure targets, not an allowlist of violators
const STATUS_FILE_FORBIDDEN_PREFIXES = [
  "plugins/config_v2/",
  "plugins/primitives/plugins/live-state/",
  "plugins/infra/plugins/jobs/",
  "plugins/database/",
  "plugins/debug/plugins/sentinel/core/",
  "plugins/debug/plugins/sentinel/server/",
];

/**
 * The machine watcher's status-file leaf (`plugins/status-file`) is read by the
 * build CLI's admission valve to say when the duress guard is off. That only
 * works while the leaf stays loadable outside a backend — the same promise the
 * duress latch makes, measured here instead of written down.
 */
const statusFileLeanCheck: Check = {
  id: "sentinel:status-file-lean",
  description:
    "the sentinel status-file leaf's core and server barrels load no config_v2, live-state, jobs, database or parent-sentinel module — the build CLI imports them",
  async run() {
    const failures: string[] = [];
    for (const entry of STATUS_FILE_ENTRIES) {
      const found = await findForbiddenModules(
        entry,
        STATUS_FILE_FORBIDDEN_PREFIXES,
      );
      if (found !== null) failures.push(found);
    }
    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: failures.join("\n  "),
      hint:
        "Keep the status-file leaf to zod, node:* and infra/paths. Anything a backend needs from the " +
        "file (the live resource, the down report) belongs in the parent sentinel plugin, which " +
        "imports the leaf — never the other way round.",
    };
  },
};

/**
 * Measure `entry`'s static closure: `null` when it reaches no forbidden subtree,
 * else a message naming the shortest import chain into each one it reaches.
 */
async function findForbiddenModules(
  entry: string,
  forbidden: readonly string[],
): Promise<string | null> {
  const root = await getWorktreeRoot();
  const closure = await importClosure(root, entry, {
    dynamicImports: "cut",
  });

  const findings: string[] = [];
  for (const prefix of forbidden) {
    const offenders = [...closure.modules].filter((m) => m.startsWith(prefix));
    if (offenders.length === 0) continue;
    const shortest = offenders
      .map((m) => closure.importChain(m))
      .reduce((a, b) => (b.length < a.length ? b : a));
    findings.push(
      `${prefix} — ${offenders.length} module(s), shortest chain:\n        ` +
        shortest.join("\n      → "),
    );
  }

  if (findings.length === 0) return null;
  return (
    `${entry} statically loads ${closure.modules.size} modules, including forbidden ones:\n    ` +
    findings.join("\n    ")
  );
}

export default [workerClosureLeanCheck, statusFileLeanCheck];
