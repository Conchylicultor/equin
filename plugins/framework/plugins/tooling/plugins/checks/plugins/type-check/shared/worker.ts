/**
 * The worker process for the `type-check` check: one per run, in its own
 * process, so the single-threaded TS-program build gets a core to itself and
 * its peak RSS is measurable from outside. It builds the program ONCE and
 * drives both consumers:
 *
 *   1. `tsc` diagnostics, through the keyed check (`./keyed-check.ts`): only
 *      the files whose key moved are checked and emitted, the rest come from
 *      the host-wide checked-results store — and, in `dual` mode, a full check
 *      of a fresh program beside it, compared file by file;
 *   2. ESLint, only the parts of each file its job names, returning the
 *      messages RAW (exemptions are the check's to apply, when it reads them):
 *      the stale SYNTACTIC rule groups with no program at all, and the TYPED
 *      part (or a directive file whole) with the SAME program injected via
 *      `parserOptions.programs`, so typescript-eslint reuses it instead of
 *      constructing a second one.
 *
 * That single construction — not the parallelism — is what removes the
 * duplicated ~99%-TS-program-build cost the two old checks each paid.
 *
 * Protocol: argv[2] is a JSON job file (so a cold run's thousands of lint paths
 * never hit the argv limit). stdout is one JSON result object. A nonzero exit
 * means the worker itself crashed (the orchestrator records no PASSes for it).
 */
import { readFileSync, unlinkSync, writeSync } from "fs";
import { dirname, relative } from "path";
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
  type RawLintMessage,
  type TscDivergence,
  type TypedPartOutcome,
  type TypeFpTable,
  type TypeCheckWorkerJob as Job,
  type TypeCheckWorkerResult as Result,
} from "../core";
import { canonical } from "./contract-refs";
import { signatureEmitOptions } from "./emit-options";
import { openFileResultsStore } from "./file-results-store";
import {
  compareResults,
  formatDiagnostic,
  keyedCheck,
  tscEngineFp,
  type KeyedCheck,
} from "./keyed-check";
import { writeProgramManifest } from "./program-manifest";
import { typedResultKey } from "./type-fingerprint";

function rel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

/** This process's CPU seconds so far (user + system). */
function cpuSeconds(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1e6;
}

/**
 * Every repo file's type fingerprint, keyed by its spelling ON DISK
 * (`rootNames`, the tsconfig's directory expansion), not the program's. On a
 * case-insensitive filesystem tsc names a file by the first spelling it
 * resolved, so the program can say `web/app.tsx` for `web/App.tsx` — and every
 * reader looks a file up by its git spelling. Every lintable file is a root
 * (the coverage gate), so re-keying the roots is exact.
 */
function onDiskFps(
  root: string,
  computed: ReadonlyMap<string, string>,
  rootNames: readonly string[],
): Record<string, string> {
  const onDisk = new Map<string, string>();
  for (const name of rootNames) {
    const p = rel(root, name);
    onDisk.set(canonical(p), p);
  }
  const fps: Record<string, string> = {};
  for (const [p, fp] of computed) fps[onDisk.get(canonical(p)) ?? p] = fp;
  return fps;
}

/** The diagnostics no file's key covers: config, options, global, syntax. */
function programDiagnostics(
  root: string,
  program: ts.Program,
  configDiagnostics: readonly ts.Diagnostic[],
): string[] {
  return [
    ...configDiagnostics,
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
  ].map((d) => formatDiagnostic(root, d));
}

/** Every checked file's diagnostics, in program order. */
function fileDiagnostics(check: KeyedCheck): string[] {
  return [...check.results.keys()]
    .sort((a, b) => a - b)
    .flatMap((i) => check.results.get(i)!.diagnostics);
}

async function run(job: Job): Promise<Result> {
  const cpuStart = cpuSeconds();
  // 1. Parse the tsconfig (glob resolution only — no type-check yet).
  const cfg = ts.readConfigFile(job.tsconfigPath, ts.sys.readFile);
  if (cfg.error) {
    return {
      name: job.name,
      tscErrors: formatDiagnostic(job.root, cfg.error),
      lint: [],
      typeFps: { kind: "unavailable", why: "the tsconfig did not parse" },
      tscLines: [],
      divergences: [],
      phaseCpuSeconds: {
        program: cpuSeconds() - cpuStart,
        check: 0,
        full: 0,
        lint: 0,
      },
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    dirname(job.tsconfigPath),
    undefined,
    job.tsconfigPath,
  );

  // 2. Build ONE program — no incremental builder: what to re-check is the
  //    keyed check's to decide (`./keyed-check.ts`). The options emit
  //    declarations, so every checked file has a real signature, and order
  //    types stably, so that signature is a function of the code
  //    (`./emit-options.ts`).
  const options = signatureEmitOptions(parsed.options, job.root);
  const configDiagnostics = ts.getConfigFileParsingDiagnostics(parsed);
  const build = (): ts.Program =>
    ts.createProgram({
      rootNames: parsed.fileNames,
      options,
      configFileParsingDiagnostics: configDiagnostics,
    });
  const program = build();
  writeProgramManifest(
    job.manifestPath,
    job.root,
    program.getSourceFiles().map((sf) => sf.fileName),
  );
  const cpuProgram = cpuSeconds();

  // 3. The keyed check: re-check and re-emit only the files whose key moved,
  //    the rest from the host-wide store. Its type fingerprints are what keys
  //    the typed lint parts below.
  const engineFp = tscEngineFp(job.root, options);
  const store = openFileResultsStore();
  const keyed = keyedCheck({
    root: job.root,
    program,
    options,
    engineFp,
    store,
    mode: "keyed",
  });
  const tscLines = [`type-check: ${keyed.summary}`];
  const head = programDiagnostics(job.root, program, configDiagnostics);
  let tscErrors = [...head, ...fileDiagnostics(keyed)].join("\n");
  const cpuCheck = cpuSeconds();

  // 3b. Dual: a full check of a FRESH program — the cold ground truth, with no
  //     checker state the walk left behind — compared file by file. Its
  //     verdict stands, and its results overwrite the store's.
  const divergences: TscDivergence[] = [];
  if (job.tscMode === "dual") {
    const fresh = build();
    // Every file's diagnostics first, in program order — exactly what `tsc`
    // does cold — so the walk below reads tsc's own answers back.
    fresh.getSemanticDiagnostics();
    const full = keyedCheck({
      root: job.root,
      program: fresh,
      options,
      engineFp,
      store,
      mode: "all",
    });
    divergences.push(...compareResults(keyed, full));
    tscLines.push(
      `type-check: ${full.summary}`,
      `type-check: dual: ${divergences.length} of ${full.results.size} files diverge from the full check`,
    );
    tscErrors = [
      ...programDiagnostics(job.root, fresh, configDiagnostics),
      ...fileDiagnostics(full),
    ].join("\n");
  }
  const cpuFull = cpuSeconds();

  const typeFps: TypeFpTable = job.typeFps
    ? {
        kind: "table",
        fps: onDiskFps(job.root, keyed.typeFps, parsed.fileNames),
      }
    : { kind: "unavailable", why: "the job did not ask for them" };

  // 4. Lint, in up to three passes per file, each with its own config:
  //
  //    - the stale SYNTACTIC groups, with NO program (`typeSource: { none }`).
  //      Only rules that read nothing but the text are registered (`kind:
  //      "syntactic"`), and a type-aware rule misdeclared as syntactic throws
  //      in `getParserServices` instead of storing an answer that read types;
  //    - the stale TYPED parts — the type-aware rules of each group whose part
  //      is not already stored — in one pass with the program;
  //    - a directive file WHOLE, every rule with the program.
  //
  //    Messages come back RAW — before exemptions, which the check applies when
  //    it reads them — and split by part, so each lands under its own key.
  const lint: LintFileResult[] = [];
  if (job.lintFiles.length > 0) {
    const contributions = await loadLintContributions(job.root);
    // A rule id's namespace is its contribution's `name`; anything else (the
    // config builder's own typescript-eslint / react-hooks / core rules) and
    // a null id (the linter itself: a parse failure) belong to the base group.
    const groupOfNamespace = new Map(
      contributions.map((c) => [c.name, c.relPath] as const),
    );
    const groupOf = (ruleId: string | null): string => {
      if (ruleId === null) return LINT_GROUP_BASE;
      const slash = ruleId.lastIndexOf("/");
      const ns = slash < 0 ? "" : ruleId.slice(0, slash);
      return groupOfNamespace.get(ns) ?? LINT_GROUP_BASE;
    };
    // One config per (kind, group set), built on first use: a run sees a
    // handful of distinct sets (every group on a cold run, one after a rule
    // edit).
    const configs = new Map<string, Promise<Linter.Config[]>>();
    const configFor = (
      kind: "syntactic" | "type-aware",
      groups: readonly string[],
    ): Promise<Linter.Config[]> => {
      const key = `${kind}\n${groups.join("\n")}`;
      let config = configs.get(key);
      if (config === undefined) {
        config = buildLintConfig({
          root: job.root,
          typeSource:
            kind === "syntactic" ? { none: true } : { programs: [program] },
          exemptions: "report",
          rules: {
            base: groups.includes(LINT_GROUP_BASE),
            contributions: new Set(groups),
            kind,
          },
        });
        configs.set(key, config);
      }
      return config;
    };
    let wholeConfig: Promise<Linter.Config[]> | undefined;
    const whole = (): Promise<Linter.Config[]> =>
      (wholeConfig ??= buildLintConfig({
        root: job.root,
        typeSource: { programs: [program] },
        exemptions: "report",
      }));

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
    // Which typed parts run and under which key: decided by prepare, or here,
    // now that the type fingerprints exist.
    const typedParts = (
      file: string,
      typed: Job["lintFiles"][number]["typed"],
    ): { group: string; key: string; run: boolean }[] => {
      if (typed.kind === "decided") {
        return typed.stale.map((p) => ({ ...p, run: true }));
      }
      if (typeFps.kind !== "table") {
        throw new Error(
          `type-check worker: ${rel(job.root, file)} needs its type fingerprint, and the job did not ask for them: ${typeFps.why}`,
        );
      }
      const typeFp = typeFps.fps[rel(job.root, file)];
      if (typeFp === undefined) {
        throw new Error(
          `type-check worker: ${rel(job.root, file)} is not in the program it was sent to be linted under`,
        );
      }
      return typed.parts.map(({ group, fp }) => {
        const key = typedResultKey(fp, typeFp);
        return { group, key, run: !typed.known.includes(key) };
      });
    };

    for (const fileJob of job.lintFiles) {
      const { file } = fileJob;
      const code = ts.sys.readFile(file);
      if (code === undefined) {
        throw new Error(`type-check worker: cannot read ${file}`);
      }
      const parts = typedParts(file, fileJob.typed);
      const typed: TypedPartOutcome[] = parts
        .filter((p) => !p.run)
        .map(({ group, key }) => ({ group, kind: "cached", key }));
      const toRun = parts.filter((p) => p.run);

      if (fileJob.unit === "whole") {
        for (const { group, key } of toRun) {
          if (group !== LINT_GROUP_ALL) {
            throw new Error(
              `type-check worker: directive file ${rel(job.root, file)} was sent typed part "${group}"`,
            );
          }
          typed.push({
            group,
            kind: "ran",
            key,
            messages: verify(file, code, await whole()),
          });
        }
        lint.push({ file, unit: "whole", syntactic: {}, typed });
        continue;
      }

      const syntactic: Record<string, RawLintMessage[]> = {};
      if (fileJob.syntactic.length > 0) {
        for (const g of fileJob.syntactic) syntactic[g] = [];
        // A message outside the selection can only be a null-id one (a parse
        // failure) on a run without the base group, whose stored result
        // already holds it.
        for (const m of verify(
          file,
          code,
          await configFor("syntactic", fileJob.syntactic),
        )) {
          syntactic[groupOf(m.ruleId)]?.push(m);
        }
      }
      if (toRun.length > 0) {
        const byGroup = new Map<string, RawLintMessage[]>(
          toRun.map((p) => [p.group, []]),
        );
        const messages = verify(
          file,
          code,
          await configFor(
            "type-aware",
            toRun.map((p) => p.group),
          ),
        );
        for (const m of messages) {
          // Null-id messages (a parse failure) belong to the syntactic base
          // part: the same text produced them there, run or stored.
          if (m.ruleId === null) continue;
          const bucket = byGroup.get(groupOf(m.ruleId));
          if (bucket === undefined) {
            throw new Error(
              `type-check worker: ${m.ruleId} reported on ${rel(job.root, file)} from a typed part that was not run`,
            );
          }
          bucket.push(m);
        }
        for (const { group, key } of toRun) {
          typed.push({
            group,
            kind: "ran",
            key,
            messages: byGroup.get(group)!,
          });
        }
      }
      lint.push({ file, unit: "split", syntactic, typed });
    }
  }

  const cpuEnd = cpuSeconds();
  return {
    name: job.name,
    tscErrors,
    lint,
    typeFps,
    tscLines,
    divergences,
    phaseCpuSeconds: {
      program: cpuProgram - cpuStart,
      check: cpuCheck - cpuProgram,
      full: cpuFull - cpuCheck,
      lint: cpuEnd - cpuFull,
    },
  };
}

// A ~16 GB process whose only reader is the check that spawned it: when that
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
