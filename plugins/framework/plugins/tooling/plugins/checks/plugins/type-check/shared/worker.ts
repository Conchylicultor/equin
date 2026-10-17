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
  LINT_GROUP_BASE,
  type LintFileResult,
  type RawLintMessage,
  type TypedDecision,
  type TypedOutcome,
  type TypeFpTable,
  type TypeCheckWorkerJob as Job,
  type TypeCheckWorkerResult as Result,
} from "../core";
import { signatureEmitOptions } from "./emit-options";
import { computeTypeFingerprints, typedResultKey } from "./type-fingerprint";

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
  written: string | undefined,
  rootNames: readonly string[],
): TypeFpTable {
  let text = written;
  if (text === undefined) {
    if (!existsSync(job.buildInfoPath)) {
      return { kind: "unavailable", why: "tsc wrote no buildinfo" };
    }
    text = readFileSync(job.buildInfoPath, "utf8");
  }
  const r = computeTypeFingerprints(text, dirname(job.buildInfoPath), job.root);
  if (r.kind !== "fps") return { kind: "unavailable", why: r.why };
  // tsc's own identity for a path: lower-cased where the filesystem ignores case.
  const canonical = (p: string): string =>
    ts.sys.useCaseSensitiveFileNames ? p : p.toLowerCase();
  const onDisk = new Map<string, string>();
  for (const name of rootNames) {
    const p = rel(job.root, name);
    onDisk.set(canonical(p), p);
  }
  const fps: Record<string, string> = {};
  for (const [p, fp] of r.fps) fps[onDisk.get(canonical(p)) ?? p] = fp;
  return { kind: "table", fps };
}

async function run(job: Job): Promise<Result> {
  // 1. Parse the tsconfig (glob resolution only — no type-check yet).
  const cfg = ts.readConfigFile(job.tsconfigPath, ts.sys.readFile);
  if (cfg.error) {
    return {
      name: job.name,
      tscErrors: formatTscDiagnostic(job.root, cfg.error),
      lint: [],
      typeFps: { kind: "unavailable", why: "the tsconfig did not parse" },
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
  const builder = ts.createIncrementalProgram({
    rootNames: parsed.fileNames,
    options: signatureEmitOptions(parsed.options, job.root, job.buildInfoPath),
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
  // is computed (that is what fills in the signatures) and dropped. The
  // buildinfo text is also KEPT: it is what the type fingerprints are read off.
  let buildInfoText: string | undefined;
  const emitResult = builder.emit(
    undefined,
    (fileName, text, writeByteOrderMark) => {
      if (fileName.endsWith(".tsbuildinfo")) {
        ts.sys.writeFile(fileName, text, writeByteOrderMark);
        buildInfoText = text;
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
  //    (`./type-fingerprint.ts`), read off the buildinfo the emit wrote. tsc
  //    writes one only when its state changed, and an unchanged program left
  //    the one on disk describing exactly this program — so that is the
  //    fallback, not a guess. A shape we cannot read is `unavailable`: fatal
  //    below only if a job needs it, so the build's fast path (no lint files)
  //    never fails over a table nobody asked for.
  const typeFps = readTypeFps(job, buildInfoText, parsed.fileNames);

  // 4. Lint, in up to three passes per file, each with its own config:
  //
  //    - the stale SYNTACTIC groups, with NO program (`typeSource: { none }`).
  //      Only rules that read nothing but the text are registered (`kind:
  //      "syntactic"`), and a type-aware rule misdeclared as syntactic throws
  //      in `getParserServices` instead of storing an answer that read types;
  //    - the TYPED part — every type-aware rule, whatever group it is in —
  //      with the program, when its key is not already stored;
  //    - a directive file WHOLE, every rule with the program.
  //
  //    Messages come back RAW — before exemptions, which the check applies when
  //    it reads them — and split by part, so each lands under its own key.
  const lint: LintFileResult[] = [];
  if (job.lintFiles.length > 0) {
    const program = builder.getProgram();
    const contributions = await loadLintContributions(job.root);
    const allContributions = new Set(contributions.map((c) => c.relPath));
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
    const syntacticConfigs = new Map<string, Linter.Config[]>();
    const syntacticConfig = async (
      groups: string[],
    ): Promise<Linter.Config[]> => {
      const key = groups.join("\n");
      let config = syntacticConfigs.get(key);
      if (config === undefined) {
        config = await buildLintConfig({
          root: job.root,
          typeSource: { none: true },
          exemptions: "report",
          rules: {
            base: groups.includes(LINT_GROUP_BASE),
            contributions: new Set(groups),
            kind: "syntactic",
          },
        });
        syntacticConfigs.set(key, config);
      }
      return config;
    };
    let typedConfig: Linter.Config[] | undefined;
    let wholeConfig: Linter.Config[] | undefined;
    const typedOnly = async (): Promise<Linter.Config[]> =>
      (typedConfig ??= await buildLintConfig({
        root: job.root,
        typeSource: { programs: [program] },
        exemptions: "report",
        rules: {
          base: true,
          contributions: allContributions,
          kind: "type-aware",
        },
      }));
    const whole = async (): Promise<Linter.Config[]> =>
      (wholeConfig ??= await buildLintConfig({
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
    // Where the typed part's result goes, and whether it must run: decided
    // by prepare (`run`), or here, now that the type fingerprints exist.
    const typedKey = (
      file: string,
      typed: Exclude<TypedDecision, { kind: "fresh" }>,
    ): { run: boolean; key: string } => {
      if (typed.kind === "run") return { run: true, key: typed.key };
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
      const key = typedResultKey(typed.fp, typeFp);
      return { run: !typed.known.includes(key), key };
    };

    for (const fileJob of job.lintFiles) {
      const { file } = fileJob;
      const code = ts.sys.readFile(file);
      if (code === undefined) {
        throw new Error(`type-check worker: cannot read ${file}`);
      }
      if (fileJob.unit === "whole") {
        const { run, key } = typedKey(file, fileJob.typed);
        lint.push({
          file,
          unit: "whole",
          typed: run
            ? { kind: "ran", key, messages: verify(file, code, await whole()) }
            : { kind: "cached", key },
        });
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
          await syntacticConfig(fileJob.syntactic),
        )) {
          syntactic[groupOf(m.ruleId)]?.push(m);
        }
      }
      let typed: TypedOutcome = { kind: "fresh" };
      if (fileJob.typed.kind !== "fresh") {
        const { run, key } = typedKey(file, fileJob.typed);
        typed = run
          ? {
              kind: "ran",
              key,
              // Null-id messages (a parse failure) belong to the syntactic
              // base part: the same text produced them there, run or stored.
              messages: verify(file, code, await typedOnly()).filter(
                (m) => m.ruleId !== null,
              ),
            }
          : { kind: "cached", key };
      }
      lint.push({ file, unit: "split", syntactic, typed });
    }
  }

  return {
    name: job.name,
    tscErrors,
    lint,
    typeFps,
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
