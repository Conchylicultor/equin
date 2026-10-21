// Everything type-check does that reads file bytes or walks the tree, before and
// after the tsc worker: the import graph, the content hashes, the tsconfig's
// include-expansion and the coverage gate, and the lint result lookups — and,
// once the worker is back, every record and the lint verdict.
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
// lint, and the keys of the parts prepare found fresh.
//
// The worker always runs: only it knows each file's result key — what keys the
// typed lint parts — and it computes them in one walk over the type check's
// store (`../shared/name-run.ts`), so every file goes to it with its typed
// parts to decide. An unchanged tree costs that walk; the outer read-set
// replay skips the whole check before this runs.

import { join, relative } from "path";
import ts from "typescript";
import {
  repoProgram,
  type TscProgram,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { globPaths } from "@plugins/framework/plugins/tooling/core";
import { loadExemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { typeAwareLintGroups } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import {
  LINT_GROUP_ALL,
  type LintFileJob,
  type LintFileResult,
  type RawLintMessage,
  type TypedPartFp,
  type TypedParts,
} from "../core";
import { buildImportGraphs } from "./import-graph";
import { computeContentHashes, type TreeListing } from "./fingerprint";
import { computeLintGroups, typedGroupFps } from "./lint-groups";
import { openLintResultStore, type LintEntry } from "./lint-results";
import { lintViolationLines } from "./lint-verdict";

/** What the runner hands the session. Structured-cloned to the thread. */
export interface PrepareInput {
  /**
   * The run's ONE reading of the tree — the same value the runner recorded the
   * outer read-set from, so this side never re-lists and cannot see a
   * different tree than the one recorded. Its `root` is the worktree root.
   */
  listing: TreeListing;
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
      /** The tsconfig the worker type-checks. */
      program: TscProgram;
      /** Every lintable file: its stale syntactic groups and its typed keys known. */
      lintFiles: LintFileJob[];
      /** The typed parts every split / directive file decides. */
      typedParts: TypedParts;
      /** Every lintable file's version (sha256 of its text), for the worker. */
      versions: Record<string, string>;
    };

/** The worker that came back (a crashed worker has no outcome, and records nothing). */
export interface ProgramOutcome {
  /** tsc reported nothing. */
  tscClean: boolean;
  /** The raw lint results, one per file the plan sent. */
  lint: LintFileResult[];
}

/** What the record phase hands back to the runner. */
export interface Finalized {
  /**
   * The transcript line saying what the worker linted, and why — after the
   * worker, because only it can tell which typed parts were stale.
   */
  lintLine: string;
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
       * The record phase. Call once, with the worker's outcome — or
       * `undefined` when there is none, because the worker crashed. Returns
       * the transcript line the run should log and the lint verdict, which
       * only this side can assemble: most files' results are in the store,
       * not in the outcome.
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
 * The coverage gate is `lintable − roots`.
 *
 * A tsconfig that will not parse is its own arm rather than an empty root list:
 * an empty list would make the coverage gate report EVERY lintable file as
 * orphaned — a wall of noise for one broken JSON file. The `unparsed` arm
 * instead skips the gate and lets the worker run, where tsc reports the broken
 * config as the one diagnostic it is.
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

  // The lint result store, per (file, content hash): which syntactic parts
  // already have a result under their current key. Each file sends its stale
  // syntactic groups (run with no program) and its typed parts with the keys
  // stored for them — the worker, which alone knows the file's result key,
  // runs the ones whose key is not among them. A file with an eslint
  // directive is one unit and goes whole.
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
    const typed = { known: entry?.typed ?? [] };
    if (directives.has(rel)) {
      lintFiles.push({
        file: join(root, rel),
        unit: "whole",
        syntactic: [],
        typed,
      });
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
    lintFiles.push({
      file: join(root, rel),
      unit: "split",
      syntactic,
      typed,
    });
  }

  const plan: Extract<Plan, { kind: "run" }> = {
    kind: "run",
    program,
    lintFiles,
    typedParts: { split: typedParts, whole: wholeParts },
    versions: Object.fromEntries(graphs.files.map((f) => [f, ch(f)])),
  };

  async function finalize(
    outcome: ProgramOutcome | undefined,
  ): Promise<Finalized> {
    const t0 = performance.now();
    let moveUps = 0;
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
    // The files the worker answered — only those where something happened;
    // every other file reused its newest stored keys, read back below.
    const answered = new Set<string>();
    if (outcome) {
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
    }

    // Every file the worker did not answer: its syntactic parts were all
    // fresh (`state.cached` holds their messages) and its typed parts reused
    // the NEWEST of its stored typed keys — one per part, so the first of
    // them. Read back here, with no write unless a reused syntactic key is
    // not already in front (one write moves it up, so a result in use is
    // never the one a sibling's newer version evicts). O(files) in memory,
    // no I/O for the common case.
    if (outcome) {
      for (const [rel, state] of states) {
        if (answered.has(rel)) continue;
        const entry = state.entry;
        if (entry === undefined) {
          throw new Error(
            `type-check: ${rel} has no stored lint result and the worker did not lint it`,
          );
        }
        const n = directives.has(rel) ? wholeParts.length : typedParts.length;
        for (const k of entry.typed.slice(0, n)) {
          state.cached.push(...(entry.messages[k] ?? []));
        }
        const front = entry.syntactic.slice(0, state.reusedSyntactic.size);
        if (front.every((k) => state.reusedSyntactic.has(k))) continue;
        moveUps++;
        store.add(rel, ch(rel), {
          syntactic: new Map(),
          typed: new Map(),
          reusedSyntactic: state.reusedSyntactic,
          reusedTyped: new Set(entry.typed.slice(0, n)),
          keepSyntactic,
          keepTyped,
        });
      }
    }

    const recordMs = performance.now() - t0;
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
      `${groups.fps.size} groups, engine ${groups.engineFiles} files)` +
      (outcome === undefined ? " — worker did not come back" : "") +
      (topStale ? ` — stale: ${topStale}` : "");

    // The lint verdict: every file's results — stored or fresh — under the
    // exemptions as they are NOW. With no outcome the worker crashed, and
    // there is nothing to assemble.
    let lintViolations: string | undefined;
    let exemptionsMs = 0;
    const t1 = performance.now();
    if (outcome) {
      const exemptions = await loadExemptions({
        root,
        glob: (pattern) => globPaths(listing.files, pattern),
      });
      exemptionsMs = performance.now() - t1;
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

    const ms = (x: number): string => (x / 1000).toFixed(1);
    return {
      lintLine: `${lintLine} (finalize: records ${ms(recordMs)}s — ${answered.size} answered, ${moveUps} moved up; exemptions ${ms(exemptionsMs)}s, verdict ${ms(performance.now() - t1 - exemptionsMs)}s)`,
      lintViolations,
    };
  }

  return { plan, finalize };
}
