/**
 * The worker process for the `type-check` check: one per run, in its own
 * process, so the single-threaded TS work gets a core to itself and its peak
 * RSS is measurable from outside. It drives both consumers:
 *
 *   1. `tsc` diagnostics, through the two-program check (`./name-run.ts`):
 *      program 1 over the files with no valid stored result, program 2 over
 *      what their changed names reach, everything else from the host-wide
 *      store — and, in `dual` mode, a full check of a fresh whole program
 *      beside it (`./full-check.ts`), compared file by file;
 *   2. ESLint, only the parts of each file its job names, returning the
 *      messages RAW (exemptions are the check's to apply, when it reads them):
 *      the stale SYNTACTIC rule groups with no program at all, and each TYPED
 *      part whose key moved inside the program that holds the file as source
 *      (`parserOptions.programs`), so typescript-eslint reuses it instead of
 *      constructing a second one.
 *
 * Protocol: argv[2] is a JSON job file (so a cold run's thousands of lint paths
 * never hit the argv limit). stdout is one JSON result object. A nonzero exit
 * means the worker itself crashed (the orchestrator records no PASSes for it).
 */
import { readFileSync, realpathSync, unlinkSync, writeSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";
import { Linter } from "eslint";
import { exitWithParent } from "@plugins/packages/plugins/flock/core";
import {
  buildLintConfig,
  loadLintContributions,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
// The job/result shapes live in this plugin's `core/` barrel: two spawners (the
// check's fan-out and the build's fast path) name them, and only one worker
// implements them. Through the barrel, not the file: a deep import into the
// plugin's own `core/` is what the browser build cannot inline.
import {
  LINT_GROUP_ALL,
  LINT_GROUP_BASE,
  type LintFileResult,
  type ProgramSize,
  type RawLintMessage,
  type TscDivergence,
  type TypedPartOutcome,
  type TypeCheckWorkerJob as Job,
  type TypeCheckWorkerResult as Result,
} from "../core";
import type { NameResult, NameRunOutput } from "./name-run";
import { signatureEmitOptions } from "./emit-options";
import { compareResults, fullCheck } from "./full-check";
import { createLintDecisions } from "./lint-decisions";
import { openLintResultStore, type LintResultStore } from "./lint-results";
import type { ProgramStats } from "./name-check";
import { createSourceFileCache } from "./name-host";
import { runNameCheck, type LintHook, type NameRunReport } from "./name-run";
import {
  bufferedNameStore,
  coldWriteThrough,
  openNameStore,
  type NameStore,
} from "./name-store";
import { openRepoView, parseTsconfigOver, type RepoView } from "./repo-view";
import { openRunBaseStore, runBaseLookup } from "./run-base";
import {
  openWalkBase,
  openWalkBaseStore,
  writeWalkBase,
  type OpenedWalkBase,
  type WalkBaseStore,
} from "./walk-base";
import {
  canonicalDeclarations,
  formatDiagnostic,
  tscEngineFp,
} from "./tsc-engine";

function rel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

/** This process's CPU seconds so far (user + system). */
function cpuSeconds(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1e6;
}

const size = (s: ProgramStats | null): ProgramSize | null =>
  s === null
    ? null
    : { sources: s.sources, checked: s.checked, contracts: s.contracts };

/** One greppable line per program and one for the walk. */
function reportLines(r: NameRunReport): string[] {
  const prog = (label: string, s: ProgramStats | null): string =>
    s === null
      ? `type-check: ${label}: none`
      : `type-check: ${label}: ${s.sources} sources (${s.checked} checked) + ${s.contracts} .d.ts + ${s.repoDecls} repo decl + ${s.env} env; build ${Math.round(s.programMs)}ms, check ${Math.round(s.checkMs)}ms, records ${Math.round(s.recordMs)}ms`;
  const ms = (x: number): number => Math.round(x);
  const w = r.walk;
  const moved =
    w.paths === null
      ? ""
      : ` (+${w.paths.added} -${w.paths.removed} ~${w.paths.modified} paths, ${w.paths.dirs} listings)`;
  return [
    `type-check: walk: ${w.mode}; D₀ ${w.d0}${moved}, D ${w.d} of ${r.files} files after ${w.rounds} rounds; entries read ${w.entries}, base shards read ${w.shards} (plan ${w.shardsBy[0]}, phase 0 ${w.shardsBy[1]}, phase 1 ${w.shardsBy[2]}, end ${w.shardsBy[3]}); ${r.first} without a valid result, ${r.pending} pending, ${r.second} re-checked (${r.keyMoved} key moved, ${r.usesBottom} use a name that may move, ${r.tainted} after a stale .d.ts), ${r.lintOnly} only linted; resolutions ${r.moved} moved, ${r.refreshed} re-keyed; versions ${ms(r.ms.versions)}ms, plan ${ms(r.ms.plan)}ms, reads ${ms(r.ms.reads)}ms, listings ${ms(r.ms.listings)}ms, walk ${ms(r.ms.walk)}ms (${w.split}), write ${ms(r.ms.write)}ms`,
    prog("program 1", r.p1),
    prog("program 2", r.p2),
  ];
}

/**
 * The lint half: each job's stale syntactic groups with no program, and its
 * typed parts — whose keys only the type check knows — in the program the
 * type check hands over (`hook`); and, against the run base, every carried
 * file whose key moved (`./lint-decisions.ts`).
 */
async function lintRunner(job: Job, view: RepoView) {
  // The base the plan carried files from: each file's key and unit, read
  // shard by shard for the files the type check keys (the preparation checked
  // every shard is stored) — only those can have moved.
  const base =
    job.lintBase === null
      ? undefined
      : runBaseLookup(openRunBaseStore(), job.lintBase);
  const baseLine = (): string | null =>
    base === undefined
      ? null
      : `type-check: lint base ${job.lintBase!.slice(0, 12)}: every file carried unless its key moved, ${job.lintFiles.length} sent; ${base.shardsRead} shards read`;
  let lintStore: LintResultStore | undefined;
  const decisions = createLintDecisions({
    lintFiles: job.lintFiles,
    typedParts: job.typedParts,
    base,
    knownTyped: (path, version) =>
      (lintStore ??= openLintResultStore()).read(path, version)?.typed ?? [],
    version: (path) => view.version(path),
    rel: (abs) => rel(job.root, abs),
    abs: (path) => join(job.root, path),
  });
  const typedOut = new Map<string, TypedPartOutcome[]>();
  if (decisions.idle) {
    return {
      hook: undefined,
      finish: (
        _keys: ReadonlyMap<string, string>,
      ): Promise<{
        results: LintFileResult[];
        lintKeys: Record<string, string>;
      }> => Promise.resolve({ results: [], lintKeys: {} }),
      counts: { typed: 0, syntactic: 0 },
      baseLine,
      jobs: decisions.jobs,
    };
  }
  // A rule id's namespace is its contribution's `name`; anything else (the
  // config builder's own typescript-eslint / react-hooks / core rules) and a
  // null id (the linter itself: a parse failure) belong to the base group.
  // Loaded on the first file that lints: a run with nothing to lint (most)
  // never pays for the rules.
  let groupOfNamespace: Map<string, string> | undefined;
  const loadGroups = async (): Promise<void> => {
    groupOfNamespace ??= new Map(
      (await loadLintContributions(job.root)).map(
        (c) => [c.name, c.relPath] as const,
      ),
    );
  };
  const groupOf = (ruleId: string | null): string => {
    if (ruleId === null) return LINT_GROUP_BASE;
    if (groupOfNamespace === undefined) {
      throw new Error(
        "type-check worker: rule groups read before they were loaded",
      );
    }
    const slash = ruleId.lastIndexOf("/");
    const ns = slash < 0 ? "" : ruleId.slice(0, slash);
    return groupOfNamespace.get(ns) ?? LINT_GROUP_BASE;
  };
  // One config per (program, kind, group set), built on first use.
  const configs = new Map<string, Promise<Linter.Config[]>>();
  const programIds = new WeakMap<ts.Program, number>();
  let nextProgram = 0;
  const configFor = (
    program: ts.Program | undefined,
    kind: "syntactic" | "type-aware" | "whole",
    groups: readonly string[],
  ): Promise<Linter.Config[]> => {
    let pid = -1;
    if (program !== undefined) {
      pid = programIds.get(program) ?? nextProgram++;
      programIds.set(program, pid);
    }
    const key = `${pid}\n${kind}\n${groups.join("\n")}`;
    let config = configs.get(key);
    if (config === undefined) {
      config = loadGroups().then(() =>
        kind === "whole"
          ? buildLintConfig({
              root: job.root,
              typeSource: { programs: [program!] },
              exemptions: "report",
            })
          : buildLintConfig({
              root: job.root,
              typeSource:
                kind === "syntactic"
                  ? { none: true }
                  : { programs: [program!] },
              exemptions: "report",
              rules: {
                base: groups.includes(LINT_GROUP_BASE),
                contributions: new Set(groups),
                kind,
              },
            }),
      );
      configs.set(key, config);
    }
    return config;
  };
  const linter = new Linter({ configType: "flat" });
  const verify = (
    file: string,
    code: string,
    config: Linter.Config[],
  ): RawLintMessage[] =>
    linter
      .verify(code, config, { filename: file })
      // `--quiet` parity: error-level (2) and fatal parse errors only.
      .filter((m) => m.severity === 2 || m.fatal)
      .map((m) => ({
        ruleId: m.ruleId,
        fatal: m.fatal === true,
        line: m.line,
        column: m.column,
        message: m.message,
      }));
  // Through the view: the text checked against the version its results are
  // stored under, so a file edited mid-run fails the run instead of recording
  // a result under another text's key.
  const read = (file: string): string => view.readText(rel(job.root, file));
  const counts = { typed: 0, syntactic: 0 };

  const hook: LintHook = {
    wants: (path, r) => decisions.wants(path, r),
    async run(program, files) {
      for (const { path, r } of files) {
        const f = decisions.jobOf(path, r)!;
        const toRun = decisions.stale(path, r);
        const code = read(f.file);
        const out: TypedPartOutcome[] = [];
        if (f.unit === "whole") {
          for (const { group, key } of toRun) {
            if (group !== LINT_GROUP_ALL) {
              throw new Error(
                `type-check worker: directive file ${path} was sent typed part "${group}"`,
              );
            }
            out.push({
              group,
              kind: "ran",
              key,
              messages: verify(
                f.file,
                code,
                await configFor(program, "whole", []),
              ),
            });
          }
        } else {
          const byGroup = new Map<string, RawLintMessage[]>(
            toRun.map((p) => [p.group, []]),
          );
          for (const m of verify(
            f.file,
            code,
            await configFor(
              program,
              "type-aware",
              toRun.map((p) => p.group),
            ),
          )) {
            // Null-id messages (a parse failure) belong to the syntactic base
            // part: the same text produced them there, run or stored.
            if (m.ruleId === null) continue;
            const bucket = byGroup.get(groupOf(m.ruleId));
            if (bucket === undefined) {
              throw new Error(
                `type-check worker: ${m.ruleId} reported on ${path} from a typed part that was not run`,
              );
            }
            bucket.push(m);
          }
          for (const { group, key } of toRun) {
            out.push({
              group,
              kind: "ran",
              key,
              messages: byGroup.get(group)!,
            });
          }
        }
        typedOut.set(path, out);
        counts.typed++;
      }
    },
    discard() {
      typedOut.clear();
      counts.typed = 0;
    },
  };

  return {
    hook,
    counts,
    baseLine,
    jobs: decisions.jobs,
    /**
     * Every answer, once the type check has given every file its key (see
     * `./lint-decisions.ts`), and the keys the check records.
     */
    finish: (keys: ReadonlyMap<string, string>) =>
      decisions.answer(keys, typedOut, async (f) => {
        const syntactic: Record<string, RawLintMessage[]> = {};
        for (const g of f.syntactic) syntactic[g] = [];
        // A message outside the selection can only be a null-id one (a
        // parse failure) on a run without the base group, whose stored
        // result already holds it.
        for (const m of verify(
          f.file,
          read(f.file),
          await configFor(undefined, "syntactic", f.syntactic),
        )) {
          syntactic[groupOf(m.ruleId)]?.push(m);
        }
        counts.syntactic++;
        return syntactic;
      }),
  };
}

/** The walk base the job names, opened — or why there is none. */
function openJobWalkBase(
  store: WalkBaseStore,
  job: Job,
  checkout: string,
): OpenedWalkBase {
  const ref = job.walkBase;
  if (ref.kind === "none") return { kind: "none", reason: "none asked for" };
  if (ref.kind === "root") {
    return openWalkBase(
      store,
      ref.root,
      `the lint base's ${ref.root.slice(0, 12)}`,
    );
  }
  if (job.lintBase !== null) {
    // The files the walk does not visit must keep the lint base's keys: only
    // the walk base bound to it can promise that.
    return {
      kind: "none",
      reason: "a lint base with no walk base bound to it",
    };
  }
  const tree = store.hint(checkout);
  if (tree === undefined) {
    return { kind: "none", reason: "no walk recorded in this checkout" };
  }
  const root = store.pointer(tree);
  if (root === undefined) {
    return { kind: "none", reason: `last walk ${tree.slice(0, 12)}: no root` };
  }
  return openWalkBase(store, root, `last walk ${tree.slice(0, 12)}`);
}

/**
 * The incremental walk's every file against the full walk's. Two `.d.ts`
 * hashes that differ are compared by their CANONICAL text: tsc prints union
 * members in type-creation order, which follows what its program loaded
 * first, so the same declarations can emit in two orders (a raw-only
 * difference, counted in `rawOnly`, the same one `canonicalDeclarations`
 * exists to hash away).
 */
function compareWalks(
  inc: NameRunOutput,
  incStore: NameStore,
  full: NameRunOutput,
  fullStore: NameStore,
  rawOnly: string[],
): TscDivergence[] {
  const a = inc.walk.all();
  const b = full.walk.all();
  const out: TscDivergence[] = [];
  const canonical = (st: NameStore, h: string): string | undefined => {
    const t = st.readContract(h);
    return t === undefined ? undefined : canonicalDeclarations(t);
  };
  for (const [file, f] of b) {
    const k = a.get(file);
    if (k === undefined) {
      out.push({ file, kind: "walk-missing", keyed: "absent", full: "walked" });
      continue;
    }
    if (k.r !== f.r) {
      out.push({ file, kind: "walk-key", keyed: k.r, full: f.r });
    }
    if (k.contract !== f.contract) {
      const x = canonical(incStore, k.contract);
      if (x !== undefined && x === canonical(fullStore, f.contract)) {
        rawOnly.push(file);
      } else
        out.push({
          file,
          kind: "walk-contract",
          keyed: k.contract,
          full: f.contract,
        });
    }
    if (k.signature !== f.signature) {
      out.push({
        file,
        kind: "walk-signature",
        keyed: k.signature,
        full: f.signature,
      });
    }
    const kd = [...k.diagnostics].sort().join("\n");
    const fd = [...f.diagnostics].sort().join("\n");
    if (kd !== fd) {
      out.push({ file, kind: "walk-diagnostics", keyed: kd, full: fd });
    }
  }
  for (const file of a.keys()) {
    if (!b.has(file)) {
      out.push({ file, kind: "walk-missing", keyed: "walked", full: "absent" });
    }
  }
  return out;
}

async function run(job: Job): Promise<Result> {
  const cpuStart = cpuSeconds();
  let lintCpu = 0;
  const empty = {
    files: 0,
    first: null,
    second: null,
    checked: 0,
    typedLinted: 0,
    syntacticLinted: 0,
  };
  // 1. The input — the job's git tree plus its overlay — and the tsconfig's
  //    include expanded over it (no filesystem walk, no type-check yet).
  const t0 = performance.now();
  const view = await openRepoView(job.root, job.tree);
  const t1 = performance.now();
  const config = parseTsconfigOver(view, job.tsconfigPath);
  const inputLine = `type-check: input: tree ${job.tree.treeHash.slice(0, 12)} (${view.files().length} files, overlay ${Object.keys(job.tree.overlay).length}); view ${Math.round(t1 - t0)}ms, tsconfig roots ${Math.round(performance.now() - t1)}ms`;
  if (config.kind === "unreadable") {
    return {
      name: job.name,
      tscErrors: formatDiagnostic(job.root, config.error),
      lint: [],
      // Nothing was keyed, so there is no lint state to record.
      lintKeys: null,
      tscLines: [inputLine],
      divergences: [],
      walkRoot: null,
      checked: [],
      missed: [],
      phaseCpuSeconds: { check: cpuSeconds() - cpuStart, full: 0, lint: 0 },
      stats: empty,
    };
  }
  const { parsed, roots } = config;
  // The options emit declarations, so every checked file has a real `.d.ts`,
  // and order types stably, so that `.d.ts` is a function of the code
  // (`./emit-options.ts`).
  const options = signatureEmitOptions(parsed.options, job.root);
  const configDiagnostics = ts
    .getConfigFileParsingDiagnostics(parsed)
    .map((d) => formatDiagnostic(job.root, d));
  if (!options.skipLibCheck) {
    throw new Error(
      "type-check: declaration inputs are never checked, which is only sound under skipLibCheck",
    );
  }

  // 2. The two programs, with typed lint inside them — walking from the
  //    walk base (`./walk-base.ts`) when there is one.
  const engine = tscEngineFp(job.root, options);
  const lint = await lintRunner(job, view);
  const timedHook: LintHook | undefined = lint.hook && {
    wants: lint.hook.wants,
    async run(program, files) {
      const c0 = cpuSeconds();
      await lint.hook!.run(program, files);
      lintCpu += cpuSeconds() - c0;
    },
    discard: () => lint.hook!.discard(),
    jobs: lint.jobs,
  };
  const store: NameStore = openNameStore();
  const walkStore = openWalkBaseStore();
  const checkout = realpathSync(job.root);
  const opened = openJobWalkBase(walkStore, job, checkout);
  // `walks` / `dual`: a FULL walk first, over the same store with its writes
  // kept apart, so the incremental one below starts from the same store.
  let fullWalk: NameRunOutput | undefined;
  const fullStore = bufferedNameStore(store);
  if (job.tscMode !== "keyed") {
    fullWalk = await runNameCheck({
      view,
      options,
      roots,
      engine,
      store: fullStore,
      cache: createSourceFileCache(),
      onMiss: "throw",
      base: {
        kind: "none",
        reason: "the full walk beside the incremental one",
      },
    });
  }
  const out = await runNameCheck({
    view,
    options,
    roots,
    engine,
    store,
    cache: createSourceFileCache(),
    ...(timedHook ? { lint: timedHook } : {}),
    onMiss: job.onMiss,
    base: opened,
  });
  const tscLines = [inputLine, ...reportLines(out.report)];
  const lintBaseLine = lint.baseLine();
  if (lintBaseLine !== null) tscLines.splice(1, 0, lintBaseLine);
  const divergences: TscDivergence[] = [];
  if (fullWalk !== undefined) {
    const rawOnly: string[] = [];
    divergences.push(...compareWalks(out, store, fullWalk, fullStore, rawOnly));
    const inc = new Set(out.checked);
    const full = new Set(fullWalk.checked);
    const onlyInc = out.checked.filter((p) => !full.has(p));
    const onlyFull = fullWalk.checked.filter((p) => !inc.has(p));
    tscLines.push(
      `type-check: walks: ${divergences.length} differences from the full walk (${rawOnly.length} .d.ts differing only in raw emit order${rawOnly.length > 0 ? `: ${rawOnly.slice(0, 5).join(", ")}` : ""}); checked ${out.checked.length} (incremental) vs ${fullWalk.checked.length} (full)${onlyInc.length + onlyFull.length > 0 ? `; only incremental: ${onlyInc.slice(0, 10).join(", ")}; only full: ${onlyFull.slice(0, 10).join(", ")}` : ""}`,
    );
  }
  if (out.report.missed.length > 0) {
    tscLines.push(
      `type-check: PREDICTION MISSED — ${out.report.missed.length} name(s) predicted stable moved (${out.report.missed
        .slice(0, 5)
        .map((m) => `${m.file}#${m.name}`)
        .join(
          ", ",
        )}); this run re-checked every file in one program, and the miss is filed as a type-check-divergence report`,
    );
  }
  const fileErrors = (
    results: ReadonlyMap<string, { diagnostics: string[] }>,
  ) => [...results.keys()].sort().flatMap((p) => results.get(p)!.diagnostics);
  let written: NameRunOutput | undefined =
    divergences.length > 0 ? undefined : out;
  let tscErrors = [
    ...configDiagnostics,
    ...out.programDiagnostics,
    ...fileErrors(out.results),
  ].join("\n");
  const cpuCheck = cpuSeconds();

  // 3. Dual: a full check of a FRESH whole program — the cold ground truth —
  //    compared file by file. Its verdict stands; on any divergence a cold
  //    run overwrites the store (`./full-check.ts`).
  if (job.tscMode === "dual") {
    const full = fullCheck(view, options, roots);
    const keyed = new Map<string, NameResult>(
      [...out.walk.all()].map(([p, f]) => [
        p,
        { diagnostics: f.diagnostics, signature: f.signature },
      ]),
    );
    const against = compareResults(keyed, full.results);
    divergences.push(...against);
    tscLines.push(
      `type-check: dual: ${against.length} of ${full.results.size} files diverge from the full check`,
    );
    tscErrors = [
      ...configDiagnostics,
      ...full.programDiagnostics,
      ...fileErrors(full.results),
    ].join("\n");
    if (divergences.length > 0) {
      // Every entry rewritten from one program over every file: a store that
      // reads nothing and writes through.
      written = await runNameCheck({
        view,
        options,
        roots,
        engine,
        store: coldWriteThrough(store),
        onMiss: "throw",
        cache: createSourceFileCache(),
        base: { kind: "none", reason: "a cold rewrite after a divergence" },
      });
      tscLines.push(
        "type-check: dual: the store was rewritten from a cold run",
      );
    }
  }
  // The walk base this run ended in: what the next run walks from. None
  // when the incremental walk diverged from the full one and nothing cold
  // was run — the next run walks from an older base, or every file.
  let walkRoot: string | null = null;
  if (written === undefined) {
    tscLines.push(
      "type-check: walk base NOT written (the incremental walk diverged)",
    );
  } else {
    const w0 = performance.now();
    const o = written.walk;
    const wrote = writeWalkBase({
      store: walkStore,
      treeHash: job.tree.treeHash,
      checkout,
      global: o.global,
      globals: o.globals,
      listings: o.listings,
      view,
      base: o.base,
      files: o.files,
      removed: o.removed,
      meaning: o.meaning,
      touch: (p, f) => store.touch(p, f.v, f.c, f.r),
    });
    walkRoot = wrote.hash;
    tscLines.push(
      `type-check: walk base ${wrote.hash.slice(0, 12)} ${wrote.wrote ? "written" : "kept"}: shards ${wrote.rebuilt} rebuilt (${wrote.fresh} new), ${wrote.carried} carried (${wrote.touched} touched); ${Math.round(performance.now() - w0)}ms`,
    );
  }
  const cpuFull = cpuSeconds();

  // 4. The syntactic parts, and every job's result.
  const { results: lintResults, lintKeys } = await lint.finish(out.keys);
  const cpuEnd = cpuSeconds();
  lintCpu += cpuEnd - cpuFull;

  const r = out.report;
  return {
    name: job.name,
    tscErrors,
    lint: lintResults,
    lintKeys,
    tscLines,
    divergences,
    walkRoot,
    checked: out.checked,
    missed: out.report.missed,
    phaseCpuSeconds: {
      check: cpuCheck - cpuStart - (lintCpu - (cpuEnd - cpuFull)),
      full: cpuFull - cpuCheck,
      lint: lintCpu,
    },
    stats: {
      files: r.files,
      first: size(r.p1),
      second: size(r.p2),
      checked: (r.p1?.checked ?? 0) + (r.p2?.checked ?? 0) - r.tainted,
      typedLinted: lint.counts.typed,
      syntacticLinted: lint.counts.syntactic,
    },
  };
}

// A multi-GB process whose only reader is the check that spawned it: when that
// check dies — even by SIGKILL — this must die too, not run on reparented to
// pid 1 with nobody left to read its result (2026-10-09, see
// research/2026-10-09-infra-spawn-children-die-with-parent.md).
exitWithParent();

const jobPath = process.argv[2];
if (!jobPath) {
  console.error("type-check worker: missing job file argument");
  process.exit(2);
}
const job = JSON.parse(readFileSync(jobPath, "utf8")) as Job;
const result = await run(job);
try {
  unlinkSync(jobPath);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
// Synchronous, because the exit below follows at once: an async stream write
// could still be buffered when the process ends.
writeSync(1, JSON.stringify(result));
// Explicit: `exitWithParent`'s lifeline thread parks in a blocking FFI flock,
// which an emptied event loop must not wait on.
process.exit(0);
