// ─── Does the incremental walk ever differ from the full walk? ─────────────
//
//   ./singularity run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/walk-replay.ts \
//     <scratch checkout> <from> <to> --data <dir> [--out <steps.json>]
//
// Replays the first-parent commits `<from>..<to>` (and `<from>` itself) in a
// SCRATCH checkout (a `git clone --shared` outside the repo, its
// `node_modules` installed — re-installed here when the lockfile moves) as
// two independent CHAINS of the type-check worker, each under its own
// `SINGULARITY_DIR` (`<dir>/inc`, `<dir>/full`):
//
//   inc  — the walk starts from the chain's last walk base
//          (`../shared/walk-base.ts`, `walkBase: hint`);
//   full — the walk visits every file (`walkBase: none`).
//
// After step 0 the incremental chain's stores are cloned into the full one, so
// both start every later step from the same history and evolve apart. Every
// step compares, and the script exits 1 on any difference:
//
//   - the walk base each chain wrote for the tree: every file's version, result
//     key, `.d.ts` hash, signature, diagnostics, names (meaning, text, edges),
//     uses and reads, resolution probes, component; every reverse index; and
//     the incremental one's ranks (each file above what it reads);
//   - the tsc verdict;
//   - a missed prediction (both chains run `onMiss: throw`).
//
// It reports each step's checked sets (incremental vs full — a placement, not
// a fact, so a difference is reported, not failed) and both workers' CPU.
//
// Manual and expensive (the first step is two cold checks): a measurement,
// run by hand, with no host admission. Type check only: the lint verdict is
// assembled by the check's preparation (`../check/`), which a script may not
// import — and every lint decision is a function of the result keys compared
// here.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { computeTreeHash } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { TypeCheckWorkerJob, TypeCheckWorkerResult } from "../core";
import { readCheckTree } from "../shared/repo-view";
import { splitKey } from "../shared/name-records";
import { openNameStore } from "../shared/name-store";
import { canonicalDeclarations } from "../shared/tsc-engine";
import {
  openWalkBaseStore,
  type WalkBaseStore,
  type WalkFileState,
  type WalkShard,
} from "../shared/walk-base";

const WORKER = fileURLToPath(new URL("../shared/worker.ts", import.meta.url));

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [scratchArg, from, to] = args;
const data = flag("--data");
const outPath = flag("--out");
if (!scratchArg || !from || !to || !data) {
  console.error(
    "usage: walk-replay.ts <scratch checkout> <from> <to> --data <dir> [--out <steps.json>]",
  );
  process.exit(2);
}
const scratch = resolve(scratchArg);
const UNBOUNDED =
  "a validation replay run by hand: two checks per commit, owned by whoever started it";

async function git(...a: string[]): Promise<string> {
  const r = await spawnCaptured(["git", "-C", scratch, ...a], {
    unbounded: UNBOUNDED,
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${a.join(" ")} exited ${r.exitCode}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

const commits = [
  await git("rev-parse", from),
  ...(await git("rev-list", "--reverse", "--first-parent", `${from}..${to}`))
    .split("\n")
    .filter(Boolean),
];

const chainDir = { inc: join(data, "inc"), full: join(data, "full") };
mkdirSync(chainDir.inc, { recursive: true });

/** Point every store at `dir`: the data root is the process's. */
function setDataDir(dir: string): void {
  process.env.SINGULARITY_DIR = dir;
}

interface ChainStep {
  cpu: number;
  checked: string[];
  tscErrors: string;
  walkLine: string;
  programs: string;
  tree: string;
}

async function runChain(
  chain: "inc" | "full",
  treeHash: string,
): Promise<ChainStep> {
  setDataDir(chainDir[chain]);
  const tsconfigPath = join(scratch, "tsconfig.json");
  const job: TypeCheckWorkerJob = {
    root: scratch,
    name: "repo",
    tsconfigPath,
    tscMode: "keyed",
    onMiss: "throw",
    lintFiles: [],
    typedParts: { split: [], whole: [] },
    lintBase: null,
    walkBase: chain === "full" ? { kind: "none" } : { kind: "hint" },
    tree: (await readCheckTree(scratch, tsconfigPath, treeHash)).tree,
  };
  const jobPath = join(os.tmpdir(), `walk-replay-${chain}-${process.pid}.json`);
  writeFileSync(jobPath, JSON.stringify(job));
  const run = await spawnCaptured([process.execPath, WORKER, jobPath], {
    cwd: scratch,
    env: { ...process.env },
    unbounded: UNBOUNDED,
  });
  if (run.exitCode !== 0) {
    throw new Error(
      `${chain}: the worker exited ${run.exitCode} (a missed prediction throws):\n${run.stderr.slice(-4000)}`,
    );
  }
  const result = JSON.parse(run.stdout) as TypeCheckWorkerResult;
  const line = (p: string): string =>
    result.tscLines.find((l) => l.startsWith(p)) ?? "";
  return {
    cpu: (run.resourceUsage.cpuTimeMicros ?? NaN) / 1e6,
    checked: result.checked,
    tscErrors: result.tscErrors,
    walkLine: line("type-check: walk:"),
    programs: `${line("type-check: program 1")} | ${line("type-check: program 2")}`,
    tree: treeHash,
  };
}

/** A chain's walk base for `tree`: its facts (placements left out) and every file. */
function baseOf(
  chain: "inc" | "full",
  tree: string,
): { facts: Record<string, unknown>; files: Map<string, WalkFileState> } {
  setDataDir(chainDir[chain]);
  const store: WalkBaseStore = openWalkBaseStore();
  const h = store.pointer(tree);
  if (h === undefined) throw new Error(`${chain}: no walk base for ${tree}`);
  const root = store.root(h)!;
  const shards: WalkShard[] = Object.values(root.shards).map(([s]) =>
    store.shard(s)!,
  );
  const files = new Map<string, WalkFileState>();
  const f: Record<string, unknown> = {};
  const comps: Record<string, string> = {};
  const ir: Record<string, unknown> = {};
  const id: Record<string, unknown> = {};
  const fi: Record<string, unknown> = {};
  const p: Record<string, unknown> = {};
  for (const s of shards) {
    for (const [path, st] of Object.entries(s.f)) {
      files.set(path, st);
      const { o: _o, m, w: _w, ...rest } = st;
      f[path] = rest;
      comps[path] = m ?? path;
    }
    Object.assign(ir, s.ir);
    Object.assign(id, s.id);
    Object.assign(fi, s.if);
    Object.assign(p, s.p);
  }
  return {
    facts: { files: f, comps, ir, id, if: fi, p, global: root.global },
    files,
  };
}

/** A chain's stored `.d.ts`, canonical (undefined: not stored). */
function canonicalOf(chain: "inc" | "full", hash: string): string | undefined {
  setDataDir(chainDir[chain]);
  const text = openNameStore().readContract(hash);
  return text === undefined ? undefined : canonicalDeclarations(text);
}

/** Every part of `a` and `b` that differs, by key, a few. */
function diff(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  at: string,
  out: string[],
): void {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = JSON.stringify(a[k]);
    const y = JSON.stringify(b[k]);
    if (x === y) continue;
    if (
      a[k] !== null &&
      b[k] !== null &&
      typeof a[k] === "object" &&
      typeof b[k] === "object" &&
      out.length < 40
    ) {
      diff(
        a[k] as Record<string, unknown>,
        b[k] as Record<string, unknown>,
        `${at}/${k.replace("\0", "#")}`,
        out,
      );
    } else if (out.length < 40) {
      out.push(
        `${at}/${k.replace("\0", "#")}: inc ${x?.slice(0, 200)} full ${y?.slice(0, 200)}`,
      );
    }
  }
}

function rankViolations(files: Map<string, WalkFileState>): string[] {
  const out: string[] = [];
  for (const [path, f] of files) {
    for (const k of [...f.u, ...(f.k ?? [])]) {
      const o = splitKey(k)[0];
      const t = files.get(o);
      if (t === undefined || o === path) continue;
      const same = (t.m ?? o) === (f.m ?? path);
      if (same ? t.o !== f.o : !(t.o < f.o)) {
        out.push(`${path} (${f.o}) reads ${o} (${t.o})`);
      }
    }
  }
  return out;
}

let failures = 0;
const steps: unknown[] = [];
let prevCommit: string | undefined;
for (const [i, c] of commits.entries()) {
  await git("checkout", "-q", "--detach", c);
  if (prevCommit !== undefined) {
    const moved = await spawnCaptured(
      [
        "git",
        "-C",
        scratch,
        "diff",
        "--quiet",
        prevCommit,
        c,
        "--",
        "bun.lock",
        "patches",
        "package.json",
        "**/package.json",
      ],
      { unbounded: UNBOUNDED },
    );
    if (moved.exitCode !== 0) {
      const inst = await spawnCaptured(
        [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
        { cwd: scratch, unbounded: UNBOUNDED },
      );
      if (inst.exitCode !== 0) {
        throw new Error(
          `bun install at ${c} exited ${inst.exitCode}: ${inst.stderr}`,
        );
      }
    }
  }
  prevCommit = c;
  const treeHash = await computeTreeHash(scratch);
  if (treeHash === null) throw new Error(`no tree hash at ${c}`);
  const inc = await runChain("inc", treeHash);
  if (i === 0) {
    // Both chains start from the same history.
    rmSync(chainDir.full, { recursive: true, force: true });
    cpSync(chainDir.inc, chainDir.full, { recursive: true });
  }
  const full = await runChain("full", treeHash);
  const problems: string[] = [];
  const a = baseOf("inc", treeHash);
  const b = baseOf("full", treeHash);
  // A `.d.ts` hash that differs only in raw emit ORDER (tsc prints union
  // members in type-creation order, which follows what its program loaded
  // first) is the same declarations: compared by canonical text.
  const rawOnly: string[] = [];
  {
    const fa = a.facts.files as Record<string, { c: string }>;
    const fb = b.facts.files as Record<string, { c: string }>;
    for (const [path, st] of Object.entries(fa)) {
      const other = fb[path];
      if (other === undefined || other.c === st.c) continue;
      const x = canonicalOf("inc", st.c);
      if (x !== undefined && x === canonicalOf("full", other.c)) {
        rawOnly.push(path);
        fa[path] = { ...st, c: other.c };
      }
    }
  }
  diff(a.facts, b.facts, "base", problems);
  for (const v of rankViolations(a.files).slice(0, 10)) {
    problems.push(`rank: ${v}`);
  }
  if (inc.tscErrors !== full.tscErrors) problems.push("tsc verdict differs");
  if (rawOnly.length > 0) {
    console.log(
      `  raw emit order only (same canonical .d.ts): ${rawOnly.join(", ")}`,
    );
  }
  const fullSet = new Set(full.checked);
  const incSet = new Set(inc.checked);
  const step = {
    i,
    commit: c.slice(0, 10),
    tree: treeHash.slice(0, 12),
    problems,
    rawOnly,
    checked: { inc: inc.checked.length, full: full.checked.length },
    onlyInc: inc.checked.filter((p) => !fullSet.has(p)).slice(0, 20),
    onlyFull: full.checked.filter((p) => !incSet.has(p)).slice(0, 20),
    cpu: { inc: inc.cpu, full: full.cpu },
    walk: { inc: inc.walkLine, full: full.walkLine },
    programs: { inc: inc.programs, full: full.programs },
    tscClean: inc.tscErrors === "",
  };
  if (problems.length > 0) failures++;
  console.log(
    `step ${i} ${step.commit}: ${problems.length === 0 ? "same" : `DIFFERS (${problems.length})`}; checked inc ${step.checked.inc} / full ${step.checked.full}; worker cpu inc ${inc.cpu.toFixed(1)}s / full ${full.cpu.toFixed(1)}s`,
  );
  for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
  console.log(`  inc:  ${inc.walkLine.slice(0, 400)}`);
  steps.push(step);
  if (outPath !== undefined) {
    writeFileSync(outPath, JSON.stringify(steps, null, 1));
  }
}
console.log(
  `walk-replay: ${commits.length} trees, ${failures} with a difference`,
);
process.exit(failures > 0 ? 1 : 0);
