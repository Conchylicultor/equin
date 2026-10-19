// Everything type-check does that reads file bytes or walks the tree, before and
// after the tsc worker: the import graph, the content hashes, the tsconfig's
// include-expansion and the coverage gate, the program key, the signature
// table and the lint result lookups — and, once the worker is back, every
// record.
//
// It is 70–130 s of SYNCHRONOUS work, and it used to run on the check runner's
// own thread. `./singularity check` runs every selected check concurrently in
// one process, so for that whole stretch no other check made progress: no
// timer fired, no socket was serviced. `migration-applies-clean` opened a pg
// connection, Postgres dropped it after its 60 s `authentication_timeout`, and
// the check failed with ECONNREFUSED. See
// research/2026-09-10-tooling-type-check-prepare-off-thread.md.
//
// So this module runs on its own thread (`./prepare-worker`, hosted by
// `./prepare-thread`), and `./index` must never import it. It has no thread
// knowledge itself: `openPreparation` is plain in-process code, which is what
// lets a test compare the thread's plan with one computed here.
//
// ONE session per run, in two phases, because the record phase needs state the
// prepare phase built: the content hash and stored entry of every file sent to
// lint, the program key and signature table when it skipped, and above all
// `keyCtx.contentHash`, the memo the post-run key recompute reuses. Keeping that memo in memory is what keeps the
// recorded program key exactly what it was when this all ran in one function.
//
// The two orderings `../CLAUDE.md` calls load-bearing both live inside this
// one module: the skip clause AFTER `lintFiles` is built (which itself needs
// the key: the signature table is looked up by it); a PASS — and a signature
// table — recorded from the manifest the worker WROTE, through the same
// `keyCtx`.

import { join, relative } from "path";
import ts from "typescript";
import {
  programManifestPath,
  repoProgram,
  type ContentHashMemo,
  type TscProgram,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { loadExemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { typeAwareLintGroups } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import {
  LINT_GROUP_ALL,
  type LintFileJob,
  type LintFileResult,
  type RawLintMessage,
  type TypedDecision,
  type TypedPartFp,
  type TypeFpTable,
} from "../core";
import { typedResultKey } from "../shared/type-fingerprint";
import { buildImportGraphs } from "./import-graph";
import { computeContentHashes, type TreeListing } from "./fingerprint";
import { computeLintGroups, typedGroupFps } from "./lint-groups";
import {
  mergeLintEntry,
  openLintResultStore,
  sameEntry,
  type LintEntry,
  type LintEntryUpdate,
} from "./lint-results";
import { lintViolationLines } from "./lint-verdict";
import {
  openProgramKeyContext,
  openProgramPasses,
  programKey,
} from "./program-key";
import { openTypeFpTables, type TableLookup } from "./type-fp-tables";

/** What the runner hands the session. Structured-cloned to the thread. */
export interface PrepareInput {
  /**
   * The run's ONE reading of the tree — the same value the runner recorded the
   * outer read-set from, so this side never re-lists and cannot see a
   * different tree than the one recorded. Its `root` is the worktree root.
   */
  listing: TreeListing;
  /**
   * `ctx.cacheEnabled !== false`. Disarms the SKIP, never the record: someone
   * forcing a real run wants the program rebuilt, and the pass it produces is
   * still a good fact to keep.
   */
  cacheEnabled: boolean;
}

/**
 * What the runner does next. Plain data — it crosses the thread boundary.
 *
 * `uncovered` is the coverage gate: some lintable file is not a root of the
 * program, so there is nothing to run and nothing to record. It is returned
 * before any cache is opened.
 */
export type Plan =
  | { kind: "uncovered"; uncovered: string[] }
  | {
      kind: "run";
      /** The program the worker builds. */
      program: TscProgram;
      /** Whether the worker must run at all (false = the program is unchanged). */
      run: boolean;
      /** The files the worker must lint, each with its stale (or undecided) parts. */
      lintFiles: LintFileJob[];
      /** True iff the program key is already recorded green (so `run` is false). */
      skipped: boolean;
      /** Why the program could not be keyed at all, when it could not. */
      unkeyed?: string;
      /** What computing the program key cost, rounded. */
      keysMs: number;
    };

/** The worker that came back (a crashed worker has no outcome, and records nothing). */
export interface ProgramOutcome {
  /** tsc reported nothing. */
  tscClean: boolean;
  /** The raw lint results, one per file the plan sent. */
  lint: LintFileResult[];
  /** The type fingerprints of the program the worker built. */
  typeFps: TypeFpTable;
}

/** What the record phase hands back to the runner. */
export interface Finalized {
  /**
   * The transcript line saying what the worker linted, and why — after the
   * worker, because without a signature table only it can tell which typed
   * parts were stale.
   */
  lintLine: string;
  /** Further transcript lines (the table record). */
  lines: string[];
  /**
   * The lint violations, assembled from every file's stored and fresh results
   * under the current exemptions — "" when there are none. Undefined when the
   * worker had files to lint and did not come back: there is no verdict to
   * assemble, and the crash is the failure.
   */
  lintViolations: string | undefined;
}

/**
 * A prepared run. Only a `run` plan has anything to finalize, so only that arm
 * carries `finalize` — narrow with `"finalize" in preparation`.
 */
export type Preparation =
  | { plan: Extract<Plan, { kind: "uncovered" }> }
  | {
      plan: Extract<Plan, { kind: "run" }>;
      /**
       * The record phase, in the order it always ran. Call once, with the
       * worker's outcome — or `undefined` when there is none, because the
       * worker crashed or the program was skipped. Returns the transcript lines
       * the run should log and the lint verdict, which only this side can
       * assemble: most files' results are in the store, not in the outcome.
       */
      finalize(outcome: ProgramOutcome | undefined): Promise<Finalized>;
    };

/** One planned file's state, kept for `finalize`. */
interface FileState {
  /** The stored entry under the file's content hash, when there is one. */
  entry: LintEntry | undefined;
  /** Messages of the parts prepare found fresh in the store. */
  cached: RawLintMessage[];
  /** The stored keys prepare reused, by kind: moved up when recorded. */
  reusedSyntactic: Set<string>;
  reusedTyped: Set<string>;
}

/** A typed part's name in the transcript's stale breakdown. */
const typedLabel = (group: string): string =>
  group === LINT_GROUP_ALL ? group : `(types) ${group}`;

const toRel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

/**
 * The program's include-expansion — its ROOTS — or the reason there is none.
 *
 * Two things need it: the coverage gate is `lintable − roots`, and half of what
 * the program key says is "which roots is this".
 *
 * A tsconfig that will not parse is its own arm rather than an empty root list,
 * and the difference is load-bearing in both directions. An empty list would
 * make the coverage gate report EVERY lintable file as orphaned — a wall of
 * noise for one broken JSON file — and it would mint a program key for a
 * program we could not describe. The `unparsed` arm instead skips the gate and
 * the key and lets the worker run, where tsc reports the broken config as the
 * one diagnostic it is.
 */
type ProgramRoots =
  { kind: "roots"; roots: string[] } | { kind: "unparsed"; why: string };

function parseProgramRoots(program: TscProgram): ProgramRoots {
  const cfg = ts.readConfigFile(program.tsconfigPath, ts.sys.readFile);
  if (cfg.error) {
    return {
      kind: "unparsed",
      why: ts.flattenDiagnosticMessageText(cfg.error.messageText, " "),
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    // The config's own directory: every `include` / `exclude` pattern in it is
    // relative to the file, and the repo tsconfig sits at the repo root.
    join(program.tsconfigPath, ".."),
    undefined,
    program.tsconfigPath,
  );
  return {
    kind: "roots",
    roots: parsed.fileNames.map((f) => ts.sys.resolvePath(f)),
  };
}

/** Prepare one run: the plan, and the session its record phase closes over. */
export async function openPreparation({
  listing,
  cacheEnabled,
}: PrepareInput): Promise<Preparation> {
  const { root } = listing;
  const program = repoProgram(root);

  // Lint universe + each file's content hash (the lint result store's key). A
  // FILTER over the listing, never its own walk: that second enumeration is
  // what let a stray `.ts` under gitignored `.cache/` reach the coverage gate
  // and fail a build over content the key never covered.
  const graphs = buildImportGraphs(listing);
  const { contentHash: ch, directives } = computeContentHashes(
    listing,
    graphs.files,
  );

  // THE COVERAGE GATE — the load-bearing replacement for projectService's
  // "every file resolves to a project". It used to need a forward-import
  // closure walk from each target's roots, because a file could legitimately be
  // outside every `include` yet reachable from one. Under a blanket include
  // that case is gone: a lintable file that is not a root is by definition
  // outside `include` (a stray `scripts/x.ts` at the repo root), which is
  // exactly what must fail. So the gate is now set subtraction.
  const rootsResult = parseProgramRoots(program);
  if (rootsResult.kind === "roots") {
    const roots = new Set(rootsResult.roots.map((abs) => toRel(root, abs)));
    const uncovered = graphs.files.filter((f) => !roots.has(f));
    if (uncovered.length > 0) return { plan: { kind: "uncovered", uncovered } };
  }

  // The rules half of every result key (`./lint-groups`): one fingerprint per
  // syntactic group, one per typed part — a part for each group that holds a
  // type-aware rule, learned by loading the contributions through the same
  // classifier the config builder registers rules with — and a directive
  // file's over all of them.
  const groups = computeLintGroups(listing, graphs, ch);
  const typedFps = typedGroupFps(groups, await typeAwareLintGroups(root));
  const typedParts: TypedPartFp[] = [...typedFps].map(([group, fp]) => ({
    group,
    fp,
  }));
  const wholeParts: TypedPartFp[] = [
    { group: LINT_GROUP_ALL, fp: groups.allFp },
  ];
  // Keys kept per part: a few versions of each, so two worktrees on two
  // versions of one rule — or of one hub's API — do not evict each other.
  const keepSyntactic = 3 * groups.fps.size;
  const keepTyped = 3 * typedParts.length;

  // The program key says "this exact program — these roots, this content,
  // these options", enumerated from the manifest the last worker wrote. It
  // keys two records: the program PASS (below) and the signature table. ONE
  // content-hash memo for the whole run, so the key recomputed after the
  // worker reads each file once and sees the same tree.
  const contentHash: ContentHashMemo = new Map();
  const keyStart = performance.now();
  const keyCtx = openProgramKeyContext(listing, contentHash);
  const passes = openProgramPasses();
  const tables = openTypeFpTables();
  const manifestPath = programManifestPath(root, program.name);
  let key: string | undefined;
  let unkeyed: string | undefined;
  if (rootsResult.kind === "unparsed") {
    unkeyed = `tsconfig did not parse: ${rootsResult.why}`;
  } else {
    const result = programKey(
      keyCtx,
      { tsconfigPath: program.tsconfigPath, manifestPath },
      rootsResult.roots,
    );
    if (result.kind === "key") key = result.key;
    else unkeyed = result.why; // no enumeration → cold run, then recorded below
  }

  // The signature table: every lintable file's type fingerprint in THIS
  // program, recorded by whichever run built it. With it every typed key is
  // known now, so only stale parts go to the worker and an all-fresh tree skips
  // it; without it (the program changed, or a cold run) the typed decisions
  // move into the worker, which alone will have the signatures.
  const table: TableLookup =
    key === undefined
      ? { kind: "none", why: "no program key" }
      : tables.read(program.name, key, graphs.files);

  // The lint result store, per (file, content hash): which parts already have
  // a result under their current key. Each file sends only its stale syntactic
  // groups (run with no program) and its typed part when it is stale or not yet
  // decidable; a file with an eslint directive is one unit and goes whole.
  const store = openLintResultStore();
  const states = new Map<string, FileState>();
  const lintFiles: LintFileJob[] = [];
  for (const rel of graphs.files) {
    const entry = store.read(rel, ch(rel));
    const state: FileState = {
      entry,
      cached: [],
      reusedSyntactic: new Set(),
      reusedTyped: new Set(),
    };
    states.set(rel, state);
    const decide = (parts: TypedPartFp[]): TypedDecision => {
      if (table.kind === "none") {
        return { kind: "deferred", parts, known: entry?.typed ?? [] };
      }
      const typeFp = table.fps.get(rel)!;
      const stale: { group: string; key: string }[] = [];
      for (const { group, fp } of parts) {
        const key = typedResultKey(fp, typeFp);
        if (entry?.typed.includes(key)) {
          state.cached.push(...(entry.messages[key] ?? []));
          state.reusedTyped.add(key);
        } else {
          stale.push({ group, key });
        }
      }
      return { kind: "decided", stale };
    };
    const needsRun = (d: TypedDecision): boolean =>
      d.kind === "deferred" || d.stale.length > 0;
    if (directives.has(rel)) {
      const typed = decide(wholeParts);
      if (needsRun(typed)) {
        lintFiles.push({
          file: join(root, rel),
          unit: "whole",
          syntactic: [],
          typed,
        });
      }
      continue;
    }
    const known = new Set(entry?.syntactic);
    const syntactic: string[] = [];
    for (const [g, fp] of groups.fps) {
      if (known.has(fp)) {
        state.cached.push(...(entry?.messages[fp] ?? []));
        state.reusedSyntactic.add(fp);
      } else {
        syntactic.push(g);
      }
    }
    const typed = decide(typedParts);
    if (syntactic.length === 0 && !needsRun(typed)) continue;
    lintFiles.push({ file: join(root, rel), unit: "split", syntactic, typed });
  }

  // THE SKIP. An outer-cache MISS rebuilds the program even when the edit
  // cannot have changed it; a program whose key is already recorded green has
  // nothing left to compute.
  //
  // The `lintFiles` clause is load-bearing, and so is its ORDERING. A file with
  // a part still to lint — a rule edit's group, an evicted result, or a typed
  // part no signature table could decide — can only be linted by the worker,
  // so a non-empty lint list defeats the skip. Reading it before `lintFiles`
  // was built would silently make that clause always true.
  //
  // `--no-cache` disarms the SKIP but not the RECORD: someone forcing a real
  // run wants the program rebuilt, and the pass it produces is still a
  // perfectly good fact to keep.
  const skipped =
    key !== undefined &&
    cacheEnabled &&
    passes.has(program.name, key) &&
    lintFiles.length === 0;
  const keysMs = Math.round(performance.now() - keyStart);

  const plan: Extract<Plan, { kind: "run" }> = {
    kind: "run",
    program,
    run: !skipped,
    lintFiles,
    skipped,
    ...(unkeyed !== undefined ? { unkeyed } : {}),
    keysMs,
  };

  async function finalize(
    outcome: ProgramOutcome | undefined,
  ): Promise<Finalized> {
    // The key of the program the worker actually built, RECOMPUTED from the
    // manifest it just WROTE, so what is recorded describes that program rather
    // than the one predicted before it ran — on a cold run the two differ, since
    // there was no enumeration to predict from at all.
    const lines: string[] = [];
    let builtKey: string | undefined;
    if (outcome && rootsResult.kind === "roots") {
      const result = programKey(
        keyCtx,
        { tsconfigPath: program.tsconfigPath, manifestPath },
        rootsResult.roots,
      );
      if (result.kind === "key") builtKey = result.key;
    }

    // Record every fresh result — violations included: the store holds what
    // the rules SAID, and the verdict is assembled from it below. A crashed
    // worker records nothing (re-lints next time).
    const fresh = new Map<string, RawLintMessage[]>();
    const ran = {
      files: 0,
      whole: 0,
      syntactic: 0,
      typed: 0,
      byPart: new Map<string, number>(),
    };
    const count = (part: string): void => {
      ran.byPart.set(part, (ran.byPart.get(part) ?? 0) + 1);
    };
    // The files the worker answered; every other file's update (only reused
    // keys) is recorded after the loop.
    const answered = new Set<string>();
    if (outcome) {
      // A worker whose program parsed answers every job: one that silently
      // dropped a file would leave it with no verdict at all. (One whose
      // tsconfig did not parse answers none, and its tsc error is the failure.)
      if (
        rootsResult.kind === "roots" &&
        outcome.lint.length !== lintFiles.length
      ) {
        throw new Error(
          `type-check: the worker returned ${outcome.lint.length} lint results for ${lintFiles.length} files`,
        );
      }
      for (const r of outcome.lint) {
        const rel = toRel(root, r.file);
        const state = states.get(rel);
        if (state === undefined) {
          throw new Error(
            `type-check: the worker returned a lint result for ${rel}, which the plan never sent`,
          );
        }
        answered.add(rel);
        const messages: RawLintMessage[] = [];
        const syntactic = new Map<string, RawLintMessage[]>();
        for (const [g, m] of Object.entries(r.syntactic)) {
          const fp = groups.fps.get(g);
          if (fp === undefined) {
            throw new Error(
              `type-check: the worker returned lint group "${g}" for ${rel}, which the plan never asked for`,
            );
          }
          syntactic.set(fp, m);
          messages.push(...m);
          count(g);
        }
        const typed = new Map<string, RawLintMessage[]>();
        for (const part of r.typed) {
          if (part.kind === "ran") {
            typed.set(part.key, part.messages);
            messages.push(...part.messages);
            count(typedLabel(part.group));
            continue;
          }
          // The worker found the deferred key among the ones the job carried,
          // which came out of this very entry.
          if (!state.entry?.typed.includes(part.key)) {
            throw new Error(
              `type-check: the worker reused typed result ${part.key} for ${rel}, which the store does not hold`,
            );
          }
          messages.push(...(state.entry.messages[part.key] ?? []));
          state.reusedTyped.add(part.key);
        }
        fresh.set(rel, messages);

        const typedRan = r.typed.some((p) => p.kind === "ran");
        if (syntactic.size > 0 || typedRan) {
          ran.files++;
          if (r.unit === "whole") {
            ran.whole++;
            ran.syntactic++;
            ran.typed++;
          } else {
            if (syntactic.size > 0) ran.syntactic++;
            if (typedRan) ran.typed++;
            if (
              syntactic.size === groups.fps.size &&
              r.typed.filter((p) => p.kind === "ran").length ===
                typedParts.length
            ) {
              ran.whole++;
            }
          }
        }
        store.add(rel, ch(rel), {
          syntactic,
          typed,
          reusedSyntactic: state.reusedSyntactic,
          reusedTyped: state.reusedTyped,
          keepSyntactic,
          keepTyped,
        });
      }

      // The signature table of the program just built, under its built key:
      // recorded whatever the verdict, since signatures are facts of the
      // program, not of whether it type-checks.
      if (builtKey !== undefined) {
        if (outcome.typeFps.kind === "table") {
          tables.record(
            program.name,
            builtKey,
            graphs.files,
            new Map(Object.entries(outcome.typeFps.fps)),
          );
        } else {
          lines.push(
            `type-check: no signature table recorded — ${outcome.typeFps.why}`,
          );
        }
      }
    }

    // Every file no worker answered whose reused keys are not already in
    // front: one write moves them up, so a result in use is never the one a
    // sibling's newer version evicts. Judged on the entry prepare read, so the
    // common case — every reused key already in front — reads and writes
    // nothing more. A skipped program records too: its results were in use.
    if (outcome || skipped) {
      for (const [rel, state] of states) {
        if (answered.has(rel) || state.entry === undefined) continue;
        const update: LintEntryUpdate = {
          syntactic: new Map(),
          typed: new Map(),
          reusedSyntactic: state.reusedSyntactic,
          reusedTyped: state.reusedTyped,
          keepSyntactic,
          keepTyped,
        };
        if (sameEntry(state.entry, mergeLintEntry(state.entry, update))) {
          continue;
        }
        store.add(rel, ch(rel), update);
      }
    }

    // One greppable line: how much the worker linted, of which kinds, and which
    // parts are why — the instrument for "did that edit cost its group, its
    // importers, or the repo".
    const topStale = [...ran.byPart]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([g, n]) => `${g} ${n}`)
      .join(", ");
    const lintLine =
      `type-check: lint ${ran.files}/${graphs.files.length} files ` +
      `(${ran.whole} whole, ${ran.files - ran.whole} partial; ` +
      `syntactic ${ran.syntactic}, typed ${ran.typed}; ` +
      `${lintFiles.length} sent; ` +
      `${groups.fps.size} groups, engine ${groups.engineFiles} files; ` +
      `typed keys from ${table.kind === "table" ? "table" : `worker (${table.why})`})` +
      (outcome === undefined && plan.run ? " — worker did not come back" : "") +
      (topStale ? ` — stale: ${topStale}` : "");

    // The lint verdict: every file's results — stored or fresh — under the
    // exemptions as they are NOW. With files to lint and no outcome the worker
    // crashed, and there is nothing to assemble.
    let lintViolations: string | undefined;
    if (outcome || lintFiles.length === 0) {
      const exemptions = await loadExemptions();
      lintViolations = lintViolationLines(
        graphs.files.map((rel) => ({
          rel,
          messages: [
            ...(states.get(rel)?.cached ?? []),
            ...(fresh.get(rel) ?? []),
          ],
        })),
        exemptions,
      ).join("\n");
    }

    // Record a program PASS when the worker came back completely clean, under
    // the key of the program it built.
    //
    // Only a fully-clean run records. A tsc error obviously must not be recorded
    // green; a lint failure need not block a TSC key, but keeping the rule
    // "clean means clean" costs one re-run of a program that was failing anyway
    // and leaves nothing to reason about later.
    if (outcome?.tscClean && lintViolations === "" && builtKey !== undefined) {
      passes.record(program.name, builtKey);
    }

    // Re-record the key of a SKIPPED program, and its signature table. Not a
    // new claim — both are the identical facts already recorded — but the
    // stores age entries out by when they were last WRITTEN, so without this a
    // program that skips successfully every day for a fortnight would be
    // evicted for being unused and pay a cold run. One write each turns the age
    // bound into "unused for 14 days", which is what it was always meant to say.
    if (skipped && key !== undefined) {
      passes.record(program.name, key);
      if (table.kind === "table") {
        tables.record(program.name, key, graphs.files, table.fps);
      }
    }

    return { lintLine, lines, lintViolations };
  }

  return { plan, finalize };
}
