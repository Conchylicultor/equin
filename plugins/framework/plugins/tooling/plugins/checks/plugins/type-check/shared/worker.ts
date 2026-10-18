/**
 * The worker process for the `type-check` check: one per run, in its own
 * process, so the single-threaded TS-program build gets a core to itself and
 * its peak RSS is measurable from outside. It builds the program ONCE and
 * drives both consumers:
 *
 *   1. `tsc` semantic diagnostics (via the incremental builder, persisting the
 *      shared `.tsbuildinfo` so warm runs re-check only the diff);
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
import { existsSync, readFileSync, unlinkSync, writeSync } from "fs";
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
  type TypedPartOutcome,
  type TypeFpTable,
  type TypeCheckWorkerJob as Job,
  type TypeCheckWorkerResult as Result,
} from "../core";
import {
  canonical,
  contractEdges,
  contractSpecifiers,
  type ContractSpecifiers,
} from "./contract-refs";
import { openContractRefsStore } from "./contract-refs-store";
import { signatureEmitOptions } from "./emit-options";
import {
  computeTypeFingerprints,
  readBuildInfoGraph,
  typedResultKey,
} from "./type-fingerprint";

function rel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

function formatTscDiagnostic(root: string, d: ts.Diagnostic): string {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${rel(root, d.file.fileName)}:${line + 1}:${character + 1} - error TS${d.code}: ${msg}`;
  }
  return `error TS${d.code}: ${msg}`;
}

/**
 * The program's type fingerprints, from the buildinfo the emit just wrote —
 * or, when tsc wrote none because nothing changed, from the one on disk, which
 * then describes this very program.
 *
 * Keyed by each root's spelling ON DISK (`rootNames`, the tsconfig's directory
 * expansion), not the buildinfo's. On a case-insensitive filesystem tsc names a
 * file by the first spelling it resolved, so the buildinfo can say
 * `web/app.tsx` for `web/App.tsx` — and every reader looks a file up by its
 * git spelling. Every lintable file is a root (the coverage gate), so re-keying
 * the roots is exact.
 */
function readTypeFps(
  job: Job,
  program: ts.Program,
  options: ts.CompilerOptions,
  written: string | undefined,
  emitted: ReadonlyMap<string, ContractSpecifiers>,
  rootNames: readonly string[],
): TypeFpTable {
  let text = written;
  if (text === undefined) {
    if (!existsSync(job.buildInfoPath)) {
      return { kind: "unavailable", why: "tsc wrote no buildinfo" };
    }
    text = readFileSync(job.buildInfoPath, "utf8");
  }
  const r = readBuildInfoGraph(text, dirname(job.buildInfoPath), job.root);
  if (r.kind !== "graph") return { kind: "unavailable", why: r.why };
  const { contracts, summary } = contractEdges(
    job.root,
    program,
    options,
    r.graph,
    emitted,
    openContractRefsStore(),
  );
  const computed = computeTypeFingerprints(r.graph, contracts);
  const onDisk = new Map<string, string>();
  for (const name of rootNames) {
    const p = rel(job.root, name);
    onDisk.set(canonical(p), p);
  }
  const fps: Record<string, string> = {};
  for (const [p, fp] of computed) fps[onDisk.get(canonical(p)) ?? p] = fp;
  return { kind: "table", fps, contracts: summary };
}

/** This process's CPU seconds so far (user + system). */
function cpuSeconds(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1e6;
}

async function run(job: Job): Promise<Result> {
  const cpuStart = cpuSeconds();
  // 1. Parse the tsconfig (glob resolution only — no type-check yet).
  const cfg = ts.readConfigFile(job.tsconfigPath, ts.sys.readFile);
  if (cfg.error) {
    return {
      name: job.name,
      tscErrors: formatTscDiagnostic(job.root, cfg.error),
      lint: [],
      typeFps: { kind: "unavailable", why: "the tsconfig did not parse" },
      phaseCpuSeconds: { tsc: cpuSeconds() - cpuStart, typeFps: 0, lint: 0 },
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    dirname(job.tsconfigPath),
    undefined,
    job.tsconfigPath,
  );

  // 2. Build ONE incremental program; gather diagnostics through the builder so
  //    its state (and the persisted .tsbuildinfo) reflects what was checked.
  //    The options emit declarations, so every file carries a real signature,
  //    and order types stably, so that signature is a function of the code
  //    (`./emit-options.ts`).
  const options = signatureEmitOptions(
    parsed.options,
    job.root,
    job.buildInfoPath,
  );
  const builder = ts.createIncrementalProgram({
    rootNames: parsed.fileNames,
    options,
  });
  const diags: ts.Diagnostic[] = [
    ...builder.getConfigFileParsingDiagnostics(),
    ...builder.getOptionsDiagnostics(),
    ...builder.getGlobalDiagnostics(),
    ...builder.getSyntacticDiagnostics(),
    ...builder.getSemanticDiagnostics(),
    // Declaration diagnostics are their own channel: an exported value whose
    // inferred type cannot be written down (TS2883 / TS4023) is only reported
    // here, and a program that cannot emit declarations cannot have real
    // signatures — so it is a real error, fixed with an annotation.
    ...builder.getDeclarationDiagnostics(),
  ];
  // Emit through a writer that persists ONLY the .tsbuildinfo. The .d.ts text
  // is computed (that is what fills in the signatures) and dropped, after
  // reading off what it names — its contract edges (`./contract-refs.ts`). The
  // buildinfo text is also KEPT: it is what the type fingerprints are read off.
  let buildInfoText: string | undefined;
  const emitted = new Map<string, ContractSpecifiers>();
  const emitResult = builder.emit(
    undefined,
    (fileName, text, writeByteOrderMark, _onError, sourceFiles) => {
      if (fileName.endsWith(".tsbuildinfo")) {
        ts.sys.writeFile(fileName, text, writeByteOrderMark);
        buildInfoText = text;
      } else if (/\.d\.[mc]?ts$/.test(fileName) && sourceFiles?.length === 1) {
        emitted.set(
          canonical(rel(job.root, sourceFiles[0]!.fileName)),
          contractSpecifiers(text),
        );
      }
    },
    undefined,
    undefined,
    undefined,
  );
  diags.push(...emitResult.diagnostics);
  const tscErrors = diags
    .map((d) => formatTscDiagnostic(job.root, d))
    .join("\n");

  // 3. The type fingerprints of the program just built
  //    (`./type-fingerprint.ts`), read off the buildinfo the emit wrote and
  //    every source file's contract edges. tsc writes a buildinfo only when its
  //    state changed, and an unchanged program left the one on disk describing
  //    exactly this program — so that is the fallback, not a guess. A shape we
  //    cannot read is `unavailable`: fatal below only if a job needs it, so the
  //    build's fast path (no lint files) never fails over a table nobody asked
  //    for.
  const program = builder.getProgram();
  const cpuTsc = cpuSeconds();
  const typeFps: TypeFpTable = job.typeFps
    ? readTypeFps(
        job,
        program,
        options,
        buildInfoText,
        emitted,
        parsed.fileNames,
      )
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
  const cpuTypeFps = cpuSeconds();
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
          `type-check worker: ${rel(job.root, file)} needs its type fingerprint, and the program's could not be read: ${typeFps.why}`,
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
    phaseCpuSeconds: {
      tsc: cpuTsc - cpuStart,
      typeFps: cpuTypeFps - cpuTsc,
      lint: cpuEnd - cpuTypeFps,
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
