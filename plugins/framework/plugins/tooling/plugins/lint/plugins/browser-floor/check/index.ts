import * as path from "node:path";
import type {
  Check,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { discoverBrowserHosts } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { isBrowserUnreachableDynamic } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { pacedHeapEnv } from "@plugins/packages/plugins/heap-pacing/core";
import { fileSetClosure } from "@plugins/plugin-meta/plugins/plugin-records/core";

// ── browser-floor:worker-closure ───────────────────────────────────────────
// `browser-floor/no-api-above-floor` holds the browser-built folders (`web/`,
// `core/`, `shared/`, `exhibits/`) to the browser floor, file by file. But a
// browser host (the website demo's in-browser server) boots plugins' `server/`
// code in a visitor's browser worker, so a `Response.json` or `URL.canParse`
// in a server file the worker loads crashes the demo on an older Safari just
// the same. Which server files those are is a fact of the host's whole
// closure — no per-file rule can see it, and a server file no browser loads
// stays free to use newer built-ins.
//
// So this check takes the closure from the shared module graph — every module
// each `bin/browser-host.ts` loads: its static imports and its `import()`s,
// minus the browser-unreachable ones (`isBrowserUnreachableDynamic`, the same
// edges web-artifacts' worker closure follows and skips) — and runs the rule
// itself on the modules of it lint does not cover, with `{ shipsToBrowser:
// true }`, in a subprocess (`../lint/worker-closure-probe.ts`): a typed
// compile of a few thousand files is seconds of synchronous work the check
// runner's shared thread must not hold.

const ID = "browser-floor:worker-closure";

/**
 * The probe, repo-relative (spawned, never imported — so its bytes, and the
 * rule's it loads, are put in the read-set by {@link recordProbeInputs}).
 */
const PROBE =
  "plugins/framework/plugins/tooling/plugins/lint/plugins/browser-floor/lint/worker-closure-probe.ts";
if (
  !path
    .join(import.meta.dir, "../lint/worker-closure-probe.ts")
    .endsWith(`/${PROBE}`)
)
  throw new Error(`${ID}: the probe is not at ${PROBE}`);

/** The rule's folder: the probe loads the rule and its helpers from it. */
const RULE_DIR = path.posix.dirname(PROBE);

/** Every repo path (outside `node_modules`) the compile asked about, by kind of question. */
interface TouchedPaths {
  read: string[];
  exists: string[];
  dirs: string[];
}

interface ProbeViolation {
  file: string;
  line: number;
  column: number;
  message: string;
}

interface ProbeAnswer {
  checked: string[];
  violations: ProbeViolation[];
  touched: TouchedPaths;
}

/** Every repo module the browser hosts' workers load, sorted. */
async function workerClosure(repo: RepoSnapshot): Promise<string[]> {
  const entries = discoverBrowserHosts(repo).map((h) => h.entry);
  if (entries.length === 0) return [];
  const { closure } = await fileSetClosure(repo, entries, {
    followDynamic: () =>
      Promise.resolve((_module, spec) => !isBrowserUnreachableDynamic(spec)),
  });
  return [...closure.modules].sort();
}

async function runProbe(
  root: string,
  modules: readonly string[],
): Promise<{ ok: true; answer: ProbeAnswer } | { ok: false; message: string }> {
  const run = await spawnCaptured(
    [process.execPath, path.join(root, PROBE), root],
    {
      cwd: root,
      // A typed compile of the worker's server code: a heavy process of its
      // own, paced as one rather than at the check pass's pace.
      env: pacedHeapEnv({ ...process.env, NO_COLOR: "1" }),
      stdin: JSON.stringify({ modules }),
      // Seconds on an idle host; ten minutes only bounds a compile that never
      // returns, under a loaded background check pass.
      timeoutMs: 600_000,
    },
  );
  if (run.exitCode !== 0) {
    return {
      ok: false,
      message: `the probe exited ${run.exitCode}:\n${run.stderr.slice(-4000)}`,
    };
  }
  return { ok: true, answer: JSON.parse(run.stdout) as ProbeAnswer };
}

/**
 * Put what the probe read into the check's read-set, through the recording
 * file set: each file the compile read or probed by its content id (absent:
 * its absence), each directory asked about by its subtree's membership, the
 * probe and the rule's own files, and the lockfile (which pins everything
 * under `node_modules`: the compiler, ESLint, MDN's compat data). So the PASS
 * replays until one of them moves. A file the compile read that the file set
 * does not hold (gitignored, on disk) is an input no fact could name: loud.
 */
function recordProbeInputs(repo: RepoSnapshot, touched: TouchedPaths): void {
  const unheld = touched.read.filter((p) => !repo.has(p));
  if (unheld.length > 0)
    throw new Error(
      `${ID}: the compile read ${unheld.length} file(s) outside the check's file set (gitignored?), which no read-set fact can key: ${unheld.slice(0, 5).join(", ")}`,
    );
  for (const p of [...touched.read, ...repo.under(RULE_DIR), "bun.lock"])
    repo.blobOf(p);
  for (const p of touched.exists) repo.has(p);
  for (const d of touched.dirs) repo.under(d);
}

export const workerClosureCheck: Check = {
  id: ID,
  // Its verdict is a function of the closure (read off the module graph
  // through the recording file set) and of what the compile reads, which the
  // probe reports: an edit outside both replays the PASS and compiles nothing.
  inputKeyed: true,
  heavyChildren: {
    what: "a TypeScript compile of the browser hosts' server code and its type closure (~4k files)",
  },
  description:
    "Every server/ or bin/ module a browser host's worker loads (the website demo's in-browser server: the closure of each bin/browser-host.ts, browser-reachable import()s included) uses only built-ins every browser of the floor has — `browser-floor/no-api-above-floor` run on the files of that closure lint does not cover",
  async run(ctx) {
    const repo = await ctx.repo();
    const modules = await workerClosure(repo);
    if (modules.length === 0) return { ok: true };
    const started = performance.now();
    const probed = await ctx.grant.run(() => runProbe(repo.root, modules));
    if (!probed.ok) return { ok: false, message: probed.message };
    const { checked, violations, touched } = probed.answer;
    recordProbeInputs(repo, touched);
    ctx.log?.(
      `${ID}: ${modules.length} worker modules, ${checked.length} outside lint's scope checked in ${Math.round(performance.now() - started)} ms`,
      "stdout",
    );
    if (violations.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${violations.length} built-in(s) newer than the browser floor in code a browser host's worker loads:\n    ${violations
        .map((v) => `${v.file}:${v.line}:${v.column}  ${v.message}`)
        .join("\n    ")}`,
      hint: "These server/ files run in a visitor's browser: the website demo's worker boots them (the closure of the host's bin/browser-host.ts). Use the floor-safe spelling from `@plugins/packages/plugins/floor-compat/core` (`jsonResponse`, `canParseUrl`, `parseUrl`, `promiseWithResolvers`), or feature-test the built-in and keep a fallback.",
    };
  },
};

export default workerClosureCheck;
