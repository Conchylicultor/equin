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
import { readFileSync, unlinkSync, writeSync } from "fs";
import { dirname, join, relative } from "path";
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
  type LintFileJob,
  type LintFileResult,
  type ProgramSize,
  type RawLintMessage,
  type TscDivergence,
  type TypedPartOutcome,
  type TypeCheckWorkerJob as Job,
  type TypeCheckWorkerResult as Result,
} from "../core";
import { signatureEmitOptions } from "./emit-options";
import { compareResults, fullCheck } from "./full-check";
import { sha256, typedResultKey } from "./keys";
import type { ProgramStats } from "./name-check";
import { createSourceFileCache } from "./name-host";
import { runNameCheck, type LintHook, type NameRunReport } from "./name-run";
import { coldWriteThrough, openNameStore, type NameStore } from "./name-store";
import { formatDiagnostic, tscEngineFp } from "./tsc-engine";

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
  return [
    `type-check: walk: ${r.files} files, ${r.first} without a valid result, ${r.pending} pending, ${r.second} re-checked (${r.keyMoved} key moved, ${r.usesBottom} use a name that may move, ${r.tainted} after a stale .d.ts), ${r.lintOnly} only linted; resolutions ${r.moved} moved, ${r.refreshed} re-keyed; versions ${ms(r.ms.versions)}ms, reads ${ms(r.ms.reads)}ms (${r.reads}), listings ${ms(r.ms.listings)}ms, walk ${ms(r.ms.walk)}ms, write ${ms(r.ms.write)}ms`,
    prog("program 1", r.p1),
    prog("program 2", r.p2),
  ];
}

/**
 * The lint half: each job's stale syntactic groups with no program, and its
 * typed parts — whose keys only the type check knows — in the program the
 * type check hands over (`hook`).
 */
async function lintRunner(job: Job) {
  const byRel = new Map<string, LintFileJob>(
    job.lintFiles.map((f) => [rel(job.root, f.file), f]),
  );
  const typedOut = new Map<string, TypedPartOutcome[]>();
  if (job.lintFiles.length === 0) {
    return {
      hook: undefined,
      finish: (_keys: ReadonlyMap<string, string>): Promise<LintFileResult[]> =>
        Promise.resolve([]),
      counts: { typed: 0, syntactic: 0 },
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
  const read = (file: string): string => {
    const code = ts.sys.readFile(file);
    if (code === undefined) {
      throw new Error(`type-check worker: cannot read ${file}`);
    }
    return code;
  };
  const partsOf = (f: LintFileJob) =>
    f.unit === "whole" ? job.typedParts.whole : job.typedParts.split;
  const stale = (f: LintFileJob, r: string) =>
    partsOf(f)
      .map(({ group, fp }) => ({ group, key: typedResultKey(fp, r) }))
      .filter((p) => !f.typed.known.includes(p.key));
  const counts = { typed: 0, syntactic: 0 };

  const hook: LintHook = {
    wants(path, r) {
      const f = byRel.get(path);
      return f !== undefined && stale(f, r).length > 0;
    },
    async run(program, files) {
      for (const { path, r } of files) {
        const f = byRel.get(path)!;
        const toRun = stale(f, r);
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
    /**
     * The result of every job where something happened, once the type check
     * has given every file its key. A file whose syntactic parts were all
     * fresh and whose typed parts all reused the NEWEST of its stored keys
     * gets no answer: the check reads those back itself.
     */
    async finish(keys: ReadonlyMap<string, string>): Promise<LintFileResult[]> {
      const results: LintFileResult[] = [];
      for (const [path, f] of byRel) {
        const r = keys.get(path);
        if (r === undefined) {
          throw new Error(
            `type-check worker: ${path} was sent to be linted and the type check gave it no result key`,
          );
        }
        const ran = typedOut.get(path) ?? [];
        const ranKeys = new Set(ran.map((p) => p.key));
        const typed: TypedPartOutcome[] = [...ran];
        const parts = partsOf(f);
        const newest = new Set(f.typed.known.slice(0, parts.length));
        let moved = ran.length > 0;
        for (const { group, fp } of parts) {
          const key = typedResultKey(fp, r);
          if (ranKeys.has(key)) continue;
          if (!f.typed.known.includes(key)) {
            throw new Error(
              `type-check worker: ${path}'s typed part ${group} is stale and no program linted it`,
            );
          }
          if (!newest.has(key)) moved = true;
          typed.push({ group, kind: "cached", key });
        }
        if (!moved && (f.unit === "whole" || f.syntactic.length === 0)) {
          continue;
        }
        const syntactic: Record<string, RawLintMessage[]> = {};
        if (f.unit === "split" && f.syntactic.length > 0) {
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
        }
        results.push({ file: f.file, unit: f.unit, syntactic, typed });
      }
      return results;
    },
  };
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
  // 1. Parse the tsconfig (glob resolution only — no type-check yet).
  const cfg = ts.readConfigFile(job.tsconfigPath, ts.sys.readFile);
  if (cfg.error) {
    return {
      name: job.name,
      tscErrors: formatDiagnostic(job.root, cfg.error),
      lint: [],
      tscLines: [],
      divergences: [],
      missed: [],
      phaseCpuSeconds: { check: cpuSeconds() - cpuStart, full: 0, lint: 0 },
      stats: empty,
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    dirname(job.tsconfigPath),
    undefined,
    job.tsconfigPath,
  );
  // The options emit declarations, so every checked file has a real `.d.ts`,
  // and order types stably, so that `.d.ts` is a function of the code
  // (`./emit-options.ts`).
  const options = signatureEmitOptions(parsed.options, job.root);
  const configDiagnostics = ts
    .getConfigFileParsingDiagnostics(parsed)
    .map((d) => formatDiagnostic(job.root, d));
  const roots = parsed.fileNames.map((f) => rel(job.root, f));
  if (!options.skipLibCheck) {
    throw new Error(
      "type-check: declaration inputs are never checked, which is only sound under skipLibCheck",
    );
  }

  // 2. The two programs, with typed lint inside them.
  const engine = tscEngineFp(job.root, options);
  const texts = new Map<string, string | undefined>();
  const textOf = (p: string): string | undefined => {
    if (texts.has(p)) return texts.get(p);
    let t: string | undefined;
    try {
      t = readFileSync(join(job.root, p), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    texts.set(p, t);
    return t;
  };
  const versions = new Map<string, string | undefined>();
  const versionOf = (p: string): string | undefined => {
    if (versions.has(p)) return versions.get(p);
    // The check's preparation hashed every lintable file already (the same
    // sha256 of the text).
    const known = job.versions[p];
    if (known !== undefined) {
      versions.set(p, known);
      return known;
    }
    const t = textOf(p);
    const v = t === undefined ? undefined : sha256(t);
    versions.set(p, v);
    return v;
  };
  const lint = await lintRunner(job);
  const timedHook: LintHook | undefined = lint.hook && {
    wants: lint.hook.wants,
    async run(program, files) {
      const c0 = cpuSeconds();
      await lint.hook!.run(program, files);
      lintCpu += cpuSeconds() - c0;
    },
    discard: () => lint.hook!.discard(),
  };
  const store: NameStore = openNameStore();
  const out = await runNameCheck({
    root: job.root,
    options,
    roots,
    engine,
    store,
    cache: createSourceFileCache(),
    versionOf,
    textOf: (p) => {
      const t = textOf(p);
      if (t === undefined) throw new Error(`type-check: cannot read ${p}`);
      return t;
    },
    ...(timedHook ? { lint: timedHook } : {}),
    onMiss: job.onMiss,
  });
  const tscLines = reportLines(out.report);
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
  let tscErrors = [
    ...configDiagnostics,
    ...out.programDiagnostics,
    ...fileErrors(out.results),
  ].join("\n");
  const cpuCheck = cpuSeconds();

  // 3. Dual: a full check of a FRESH whole program — the cold ground truth —
  //    compared file by file. Its verdict stands; on any divergence a cold
  //    run overwrites the store (`./full-check.ts`).
  const divergences: TscDivergence[] = [];
  if (job.tscMode === "dual") {
    const full = fullCheck(job.root, options, roots);
    divergences.push(...compareResults(out.results, full.results));
    tscLines.push(
      `type-check: dual: ${divergences.length} of ${full.results.size} files diverge from the full check`,
    );
    tscErrors = [
      ...configDiagnostics,
      ...full.programDiagnostics,
      ...fileErrors(full.results),
    ].join("\n");
    if (divergences.length > 0) {
      // Every entry rewritten from one program over every file: a store that
      // reads nothing and writes through.
      await runNameCheck({
        root: job.root,
        options,
        roots,
        engine,
        store: coldWriteThrough(store),
        onMiss: "throw",
        cache: createSourceFileCache(),
        versionOf,
        textOf: (p) => textOf(p)!,
      });
      tscLines.push(
        "type-check: dual: the store was rewritten from a cold run",
      );
    }
  }
  const cpuFull = cpuSeconds();

  // 4. The syntactic parts, and every job's result.
  const lintResults = await lint.finish(out.keys);
  const cpuEnd = cpuSeconds();
  lintCpu += cpuEnd - cpuFull;

  const r = out.report;
  return {
    name: job.name,
    tscErrors,
    lint: lintResults,
    tscLines,
    divergences,
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
