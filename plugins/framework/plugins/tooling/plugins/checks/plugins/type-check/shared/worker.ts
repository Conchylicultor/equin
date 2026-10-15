/**
 * The worker process for the `type-check` check: one per run, in its own
 * process, so the single-threaded TS-program build gets a core to itself and
 * its peak RSS is measurable from outside. It builds the program ONCE and
 * drives both consumers:
 *
 *   1. `tsc` semantic diagnostics (via the incremental builder, persisting the
 *      shared `.tsbuildinfo` so warm runs re-check only the diff);
 *   2. type-aware ESLint, with the SAME program injected via `parserOptions.programs`
 *      so typescript-eslint reuses it instead of constructing a second one —
 *      only the rule groups each file's job names, returning the messages RAW
 *      (exemptions are the check's to apply, when it reads them).
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
  type LintFileJob,
  type LintFileResult,
  type RawLintMessage,
  type TypeCheckWorkerJob as Job,
  type TypeCheckWorkerResult as Result,
} from "../core";

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

async function run(job: Job): Promise<Result> {
  // 1. Parse the tsconfig (glob resolution only — no type-check yet).
  const cfg = ts.readConfigFile(job.tsconfigPath, ts.sys.readFile);
  if (cfg.error) {
    return {
      name: job.name,
      tscErrors: formatTscDiagnostic(job.root, cfg.error),
      lint: [],
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
  //
  //    Declarations are EMITTED, to a writer that keeps nothing but the
  //    buildinfo. Not for the .d.ts files — nothing reads them — but for what
  //    computing them puts INTO the buildinfo: a real per-file signature, the
  //    hash of each file's public shape. Under `noEmit` tsc stores a placeholder
  //    (signature = version) for every file, so it cannot tell a body edit from
  //    an API change and re-checks a hub's entire importer closure either way:
  //    measured on web-core, a one-line body edit in a file with a thousand
  //    importers cost 168 CPU-s and 7.8 GB, the same as cold. With real
  //    signatures the same edit costs the identical-tree floor, 38 CPU-s and
  //    2.5 GB; an edit that changes an API still re-checks its importers, as it
  //    must. `rootDir` is the repo root so every file has a well-defined output
  //    path (without it tsc reports TS6059 for anything outside the tsconfig's
  //    own directory); `outDir` is named but never written. See
  //    research/2026-09-09-global-type-check-zone-cut.md, Finding 5.
  const builder = ts.createIncrementalProgram({
    rootNames: parsed.fileNames,
    options: {
      ...parsed.options,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: job.root,
      outDir: `${job.buildInfoPath}.decl-out`,
      incremental: true,
      tsBuildInfoFile: job.buildInfoPath,
    },
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
  // is computed (that is what fills in the signatures) and dropped.
  const emitResult = builder.emit(
    undefined,
    (fileName, text, writeByteOrderMark) => {
      if (fileName.endsWith(".tsbuildinfo")) {
        ts.sys.writeFile(fileName, text, writeByteOrderMark);
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

  // 3. Type-aware lint, reusing the program just built (no second construction).
  //
  //    Each file names the rule GROUPS it needs (`../check/lint-groups`): the
  //    ones whose stored result is stale, or `LINT_GROUP_ALL` for a file that
  //    carries an eslint directive. One config per distinct selection, built
  //    once. Messages come back RAW — before exemptions, which the check applies
  //    when it reads them — and split by group, so each lands under its own key.
  const lint: LintFileResult[] = [];
  if (job.lintFiles.length > 0) {
    const program = builder.getProgram();
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
    const configs = new Map<string, Linter.Config[]>();
    const configFor = async (
      groups: LintFileJob["groups"],
    ): Promise<Linter.Config[]> => {
      const key = groups === LINT_GROUP_ALL ? groups : groups.join("\n");
      let config = configs.get(key);
      if (config === undefined) {
        config = await buildLintConfig({
          root: job.root,
          typeSource: { programs: [program] },
          exemptions: "report",
          ...(groups === LINT_GROUP_ALL
            ? {}
            : {
                rules: {
                  base: groups.includes(LINT_GROUP_BASE),
                  contributions: new Set(groups),
                },
              }),
        });
        configs.set(key, config);
      }
      return config;
    };
    const linter = new Linter({ configType: "flat" });
    for (const { file, groups } of job.lintFiles) {
      const code = ts.sys.readFile(file);
      if (code === undefined) continue;
      // `--quiet` parity: error-level (2) and fatal parse errors only.
      const messages: RawLintMessage[] = linter
        .verify(code, await configFor(groups), { filename: file })
        .filter((m) => m.severity === 2 || m.fatal)
        .map((m) => ({
          ruleId: m.ruleId,
          fatal: m.fatal === true,
          line: m.line,
          column: m.column,
          message: m.message,
        }));
      const byGroup: Record<string, RawLintMessage[]> = {};
      if (groups === LINT_GROUP_ALL) {
        byGroup[LINT_GROUP_ALL] = messages;
      } else {
        for (const g of groups) byGroup[g] = [];
        // A message outside the selection can only be a null-id one (a parse
        // failure) on a run without the base group, whose stored result
        // already holds it.
        for (const m of messages) byGroup[groupOf(m.ruleId)]?.push(m);
      }
      lint.push({ file, groups: byGroup });
    }
  }

  return { name: job.name, tscErrors, lint };
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
