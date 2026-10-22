// Everything type-check does that reads file bytes or the tree, before and
// after the tsc worker: the run's tree and its overlay, the tsconfig's
// include-expansion and the coverage gate, the lint rule groups, the run base
// and the lint result lookups — and, once the worker is back, every record,
// the next run base and the lint verdict.
//
// It is SYNCHRONOUS work — 70–130 s of it when it ran the tsconfig expansion
// over the filesystem and built a whole-repo import graph — and it used to run
// on the check runner's own thread. `./singularity check` runs every selected check concurrently in
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
// prepare phase built: the version, directive flag and stored entry of every
// file sent to lint, the base the rest were carried from, and the keys of the
// parts prepare found fresh.
//
// What a file IS here is its git blob sha in the run's tree
// (`../shared/repo-view.ts`): every store is keyed on it.
//
// THE RUN BASE (`../shared/run-base.ts`) is what keeps a run O(changes): the
// complete per-file lint state a completed run ended in, content-addressed by
// tree and sharded per leaf plugin. A run picks one (its own tree's, the
// worktree's last, HEAD's, the merge-base's — the first stored), compares each
// shard's listing (paths and versions, hashed from the current tree with no
// read) with the base's, and sends the worker only the files whose state does
// not carry: changed, added, or — when the rules moved — every file, with the
// base's results counted as known. Every other file carries; the worker, which
// alone knows each file's result key, re-lints a carried file's typed parts
// only where its key moved. `finalize` patches the base with what came back,
// writes the shards that changed and a new root, and assembles the verdict
// from the shards that hold messages.

import { realpathSync } from "fs";
import { join, relative } from "path";
import {
  readTreeSnapshot,
  repoProgram,
  type TscProgram,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { globPaths } from "@plugins/framework/plugins/tooling/core";
import {
  isLintRuleId,
  loadExemptions,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { typeAwareLintGroups } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  LINT_GROUP_ALL,
  type LintFileJob,
  type LintFileResult,
  type RawLintMessage,
  type TypeCheckTree,
  type TypeCheckWorkerJob,
  type TypedPartFp,
  type TypedParts,
} from "../core";
import { typedResultKey } from "../shared/keys";
import {
  mergeLintEntry,
  openLintResultStore,
  sameEntry,
  type LintEntry,
  type LintEntryUpdate,
} from "../shared/lint-results";
import { readCheckTree, viewOfSnapshot } from "../shared/repo-view";
import {
  dayNumber,
  fileBase,
  hasMessages,
  listingHash,
  messagesOf,
  openRunBaseStore,
  RUN_BASE_FORMAT,
  sameLintInputs,
  shardOf,
  TOUCH_AFTER_DAYS,
  type FileBase,
  type RunBaseLint,
  type RunBaseRoot,
  type RunBaseStore,
  type ShardRef,
} from "../shared/run-base";
import { hasLintDirective } from "./fingerprint";
import { lintableFiles } from "./import-graph";
import {
  codeCheckoutRoot,
  computeLintGroups,
  typeAwareKey,
  typedGroupFps,
} from "./lint-groups";
import { lintViolationLines } from "./lint-verdict";

/** What the runner hands the session. Structured-cloned to the thread. */
export interface PrepareInput {
  /** The worktree root. */
  root: string;
  /**
   * The run's tree — the hash the runner took (`ctx.snapshot()`), the same
   * tree it recorded the outer read-set from. The thread loads the snapshot
   * itself from it (one `git ls-tree`), so no 12k-entry listing crosses the
   * thread boundary and this side cannot see a different tree.
   */
  treeHash: string;
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
      /**
       * The lintable files whose state does not carry from the base: their
       * stale syntactic groups and their typed keys known. Every lintable
       * file when there is no base, or the rules moved.
       */
      lintFiles: LintFileJob[];
      /** The typed parts every split / directive file decides. */
      typedParts: TypedParts;
      /**
       * The run base every other lintable file carries from, by its root's
       * hash — null when `lintFiles` names them all.
       */
      lintBase: string | null;
      /**
       * The walk base the worker's walk starts from: the one the chosen
       * base's run ended in (bound to it, `TypeCheckWorkerJob.walkBase`), or
       * none — then, with no lint base either, the worker's own last walk.
       */
      walkBase: TypeCheckWorkerJob["walkBase"];
      /**
       * The input the worker checks: the run's tree and its overlay (the
       * gitignored program roots, versioned) — the same versions this side
       * keyed lint on.
       */
      tree: TypeCheckTree;
      /** Wall ms per prepare phase, in order — the transcript's breakdown. */
      phaseMs: [string, number][];
      /** Which base the plan carried from, and how much it left to do. */
      baseLine: string;
    };
/** The worker that came back (a crashed worker has no outcome, and records nothing). */
export interface ProgramOutcome {
  /** tsc reported nothing. */
  tscClean: boolean;
  /** The raw lint results, per file where something happened. */
  lint: LintFileResult[];
  /**
   * The result key of every planned file and of every carried file whose key
   * moved (`TypeCheckWorkerResult.lintKeys`); null when the worker keyed
   * nothing, which records nothing.
   */
  keys: Record<string, string> | null;
  /** The walk base the worker's run ended in, recorded in the next root. */
  walkRoot: string | null;
}

/** What the record phase hands back to the runner. */
export interface Finalized {
  /**
   * The transcript line saying what the worker linted, and why — after the
   * worker, because only it can tell which typed parts were stale.
   */
  lintLine: string;
  /**
   * The lint violations, assembled from every file's state under the current
   * exemptions — "" when there are none. Undefined when the worker did not
   * come back (or keyed nothing): there is no verdict to assemble, and the
   * crash is the failure.
   */
  lintViolations: string | undefined;
  /** What the record phase did with the run base: shards rebuilt, root written. */
  baseLine: string;
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
       * only this side can assemble: most files' results are in the base,
       * not in the outcome.
       */
      finalize(outcome: ProgramOutcome | undefined): Promise<Finalized>;
    };

/** One planned file's state, kept for `finalize`. */
interface JobState {
  /** The file's version: its git blob sha (the store's key). */
  version: string;
  /** Whether its text can carry an eslint directive: one unit when it can. */
  directive: boolean;
  /** The per-file store's entry under the file's version, when there is one. */
  stored: LintEntry | undefined;
  /**
   * Every result known for this text: the stored entry, plus — when the rules
   * moved since the base — the base's state of the same text, under the
   * base's keys.
   */
  known: LintEntry | undefined;
  /** The syntactic keys of `known` this run reuses (one per fresh group). */
  reusedSyntactic: Set<string>;
}

/** The base a run carries from. */
interface ChosenBase {
  label: string;
  treeHash: string;
  hash: string;
  root: RunBaseRoot;
}

type BaseChoice =
  ({ kind: "base" } & ChosenBase) | { kind: "none"; reason: string };

/** A typed part's name in the transcript's stale breakdown. */
const typedLabel = (group: string): string =>
  group === LINT_GROUP_ALL ? group : `(types) ${group}`;

const toRel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

const GIT_TIMEOUT_MS = 60_000;

/**
 * One git answer in the checkout, or undefined when git says there is none
 * (no HEAD yet, no `main`, no common ancestor) — a base candidate that does
 * not exist, not a failure. A hung git is one, and throws.
 */
async function gitLine(
  root: string,
  args: string[],
): Promise<string | undefined> {
  const out = await spawnCaptured(["git", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (out.timedOut) {
    throw new Error(`type-check: git ${args.join(" ")} timed out in ${root}`);
  }
  if (out.exitCode !== 0) return undefined;
  const line = out.stdout.trim();
  return line === "" ? undefined : line;
}

const treeOf = (root: string, rev: string): Promise<string | undefined> =>
  gitLine(root, ["rev-parse", "--verify", "-q", `${rev}^{tree}`]);

/**
 * The base a run carries from: the first candidate tree with a stored root —
 * this very tree (a re-run, or a sibling's), the worktree's last completed
 * run's, `HEAD`'s, the merge-base with `main`'s. Which one wins decides only
 * how much is left to do (`../shared/run-base.ts`): a hint is never trusted
 * for the verdict. A base that names a shard the store no longer holds is
 * refused — the run takes the full path and says why.
 */
async function chooseBase(
  root: string,
  worktree: string,
  treeHash: string,
  bases: RunBaseStore,
): Promise<BaseChoice> {
  const candidates: [string, () => Promise<string | undefined>][] = [
    ["this tree", () => Promise.resolve(treeHash)],
    ["last run", () => Promise.resolve(bases.hint(worktree))],
    ["HEAD", () => treeOf(root, "HEAD")],
    [
      "merge-base",
      async () => {
        const mb = await gitLine(root, ["merge-base", "HEAD", "main"]);
        return mb === undefined ? undefined : treeOf(root, mb);
      },
    ],
  ];
  const misses: string[] = [];
  const seen = new Set<string>();
  for (const [label, get] of candidates) {
    const t = await get();
    if (t === undefined) {
      misses.push(`${label}: none`);
      continue;
    }
    if (seen.has(t)) continue;
    seen.add(t);
    const hash = bases.pointer(t);
    if (hash === undefined) {
      misses.push(`${label} ${t.slice(0, 12)}: no base`);
      continue;
    }
    const base = bases.root(hash);
    if (base === undefined) {
      misses.push(`${label} ${t.slice(0, 12)}: root pruned`);
      continue;
    }
    const refs = Object.values(base.shards);
    const missing = refs.filter(([h]) => !bases.hasShard(h)).length;
    if (missing > 0) {
      return {
        kind: "none",
        reason: `${label} ${t.slice(0, 12)}'s base is missing ${missing} of ${refs.length} shards — full path`,
      };
    }
    return { kind: "base", label, treeHash: t, hash, root: base };
  }
  return { kind: "none", reason: misses.join("; ") };
}

/**
 * A base file's state as a lint entry under the base's keys — what a run
 * whose rules moved counts as known for the same text, so a group whose
 * fingerprint did not move is not re-run.
 */
function baseEntry(f: FileBase, lint: RunBaseLint): LintEntry {
  if (f.d === 1) {
    const k = typedResultKey(lint.allFp, f.r);
    const m = f.t?.[LINT_GROUP_ALL];
    return {
      directive: true,
      syntactic: [],
      typed: [k],
      messages: m === undefined ? {} : { [k]: m },
    };
  }
  const messages: LintEntry["messages"] = {};
  const syntactic: string[] = [];
  for (const [g, fp] of Object.entries(lint.fps)) {
    syntactic.push(fp);
    const m = f.s?.[g];
    if (m !== undefined) messages[fp] = m;
  }
  const typed: string[] = [];
  for (const [g, fp] of Object.entries(lint.typed)) {
    const k = typedResultKey(fp, f.r);
    typed.push(k);
    const m = f.t?.[g];
    if (m !== undefined) messages[k] = m;
  }
  return { directive: false, syntactic, typed, messages };
}

/** The union of two entries for one text: `a`'s keys first. */
function unionEntry(a: LintEntry | undefined, b: LintEntry): LintEntry {
  if (a === undefined) return b;
  if (a.directive !== b.directive) {
    throw new Error(
      `type-check: the lint store says directive=${a.directive} and the run base ${b.directive} for one text — a key does not name one text`,
    );
  }
  const union = (x: string[], y: string[]) => [
    ...x,
    ...y.filter((k) => !x.includes(k)),
  ];
  return {
    directive: a.directive,
    syntactic: union(a.syntactic, b.syntactic),
    typed: union(a.typed, b.typed),
    messages: { ...b.messages, ...a.messages },
  };
}

/** Prepare one run: the plan, and the session its record phase closes over. */
export async function openPreparation({
  root,
  treeHash,
}: PrepareInput): Promise<Preparation> {
  const program = repoProgram(root);
  const phaseMs: [string, number][] = [];
  let mark = performance.now();
  let cpuMark = process.cpuUsage();
  const lap = (name: string): void => {
    const now = performance.now();
    const cpu = process.cpuUsage(cpuMark);
    phaseMs.push([
      `${name} (cpu ${((cpu.user + cpu.system) / 1e6).toFixed(1)}s)`,
      now - mark,
    ]);
    mark = now;
    cpuMark = process.cpuUsage();
  };

  // The input, read once: the run's tree (by the hash the runner took), the
  // ignored entries git lists, and the tsconfig's include expanded over both
  // — no filesystem walk. Its roots without a blob are the OVERLAY (the
  // gitignored composition registries), versioned by their bytes; the worker
  // gets both, so the two sides check one input.
  const { tree, view, config } = await readCheckTree(
    root,
    program.tsconfigPath,
    treeHash,
  );
  // The lint universe: a FILTER over the tree, never its own walk — that
  // second enumeration is what let a stray `.ts` under gitignored `.cache/`
  // reach the coverage gate and fail a build over content the key never
  // covered. (Overlay files are generated, so never lintable.)
  const files = lintableFiles(view.files());
  const version = (rel: string): string => view.version(rel)!;
  lap("tree + tsconfig roots");

  // THE COVERAGE GATE — the load-bearing replacement for projectService's
  // "every file resolves to a project". It used to need a forward-import
  // closure walk from each target's roots, because a file could legitimately be
  // outside every `include` yet reachable from one. Under a blanket include
  // that case is gone: a lintable file that is not a root is by definition
  // outside `include` (a stray `scripts/x.ts` at the repo root), which is
  // exactly what must fail. So the gate is now set subtraction. A tsconfig
  // that will not parse skips it: the worker reports the broken config as the
  // one diagnostic it is, where an empty root list would report every file.
  if (config.kind === "parsed") {
    const roots = new Set(config.roots);
    const uncovered = files.filter((f) => !roots.has(f));
    if (uncovered.length > 0) return { plan: { kind: "uncovered", uncovered } };
  }

  // The rules half of every result key (`./lint-groups`): one fingerprint per
  // syntactic group, one per typed part — a part for each group that holds a
  // type-aware rule — and a directive file's over all of them.
  // The rules are code, versioned in the tree of the checkout they run from:
  // on a check run, the checked tree itself.
  const codeRoot = codeCheckoutRoot();
  const code =
    realpathSync(codeRoot) === realpathSync(root)
      ? view
      : viewOfSnapshot(await readTreeSnapshot(codeRoot), {});
  const groups = computeLintGroups(view, code);
  lap(`lint groups, ${groups.parsedFiles} files parsed`);
  // Which groups hold a type-aware rule is learned by loading every
  // contribution through the classifier the config builder registers rules
  // with — ~1.2 CPU-s — so it is stored under a key of what it is a function
  // of, and loaded only when a group moved.
  const store = openLintResultStore();
  const awareKey = typeAwareKey(groups);
  let typeAware = store.readTypeAware(awareKey);
  const typeAwareLoaded = typeAware === undefined;
  if (typeAware === undefined) {
    typeAware = await typeAwareLintGroups(root);
    store.writeTypeAware(awareKey, typeAware);
  }
  const typedFps = typedGroupFps(groups, typeAware);
  lap(`type-aware groups ${typeAwareLoaded ? "loaded" : "stored"}`);
  const typedParts: TypedPartFp[] = [...typedFps].map(([group, fp]) => ({
    group,
    fp,
  }));
  const wholeParts: TypedPartFp[] = [
    { group: LINT_GROUP_ALL, fp: groups.allFp },
  ];
  // The inputs this run's state is valid under: what the next run's base
  // compares.
  const lint: RunBaseLint = {
    fps: Object.fromEntries(groups.fps),
    typed: Object.fromEntries(typedFps),
    allFp: groups.allFp,
  };
  // Keys kept per part: a few versions of each, so two worktrees on two
  // versions of one rule — or of one hub's API — do not evict each other.
  const keepSyntactic = 3 * groups.fps.size;
  const keepTyped = 3 * typedParts.length;

  // ── The run base ──
  // The current tree by shard, each shard's listing hashed from the versions
  // in hand — no read — and the base to carry from.
  const shardFiles = new Map<string, string[]>();
  for (const rel of files) {
    const s = shardOf(rel);
    let list = shardFiles.get(s);
    if (list === undefined) shardFiles.set(s, (list = []));
    list.push(rel);
  }
  const listings = new Map<string, string>();
  for (const [s, rels] of shardFiles) {
    listings.set(s, listingHash(rels.map((r) => [r, version(r)] as const)));
  }
  const worktree = realpathSync(root);
  const bases = openRunBaseStore();
  const choice = await chooseBase(root, worktree, treeHash, bases);
  const base: ChosenBase | undefined =
    choice.kind === "base" ? choice : undefined;
  const same = base !== undefined && sameLintInputs(base.root.lint, lint);

  /** Base shards read, by id: where a carried file's state comes from. */
  const baseShards = new Map<string, Record<string, FileBase>>();
  const readBaseShard = (id: string): Record<string, FileBase> => {
    let got = baseShards.get(id);
    if (got !== undefined) return got;
    const ref = base?.root.shards[id];
    if (ref === undefined) {
      got = {};
    } else {
      const shard = bases.shard(ref[0]);
      if (shard === undefined) {
        throw new Error(
          `type-check: the run base ${base!.hash}'s shard ${id} (${ref[0]}) vanished after it was chosen`,
        );
      }
      got = shard.files;
    }
    baseShards.set(id, got);
    return got;
  };
  /** A file's base state, when the base holds this very text. */
  const carriedOf = (rel: string): FileBase | undefined => {
    if (base === undefined) return undefined;
    const b = readBaseShard(shardOf(rel))[rel];
    return b !== undefined && b.v === view.version(rel) ? b : undefined;
  };

  // The files to send. Same rules: a shard whose listing is the base's
  // carries whole; in any other, each file whose version moved (or is new) is
  // sent. Other rules: every file is sent, its base state counted as known.
  let jobPaths: string[];
  let changed = 0;
  let removed = 0;
  if (base !== undefined && same) {
    const sent = new Set<string>();
    for (const [s, rels] of shardFiles) {
      if (base.root.shards[s]?.[1] === listings.get(s)) continue;
      const prior = readBaseShard(s);
      for (const rel of rels) {
        if (prior[rel]?.v !== version(rel)) sent.add(rel);
      }
      const now = new Set(rels);
      removed += Object.keys(prior).filter((p) => !now.has(p)).length;
    }
    jobPaths = files.filter((rel) => sent.has(rel));
    changed = jobPaths.length;
  } else {
    jobPaths = files;
    if (base !== undefined) {
      changed = files.filter((rel) => carriedOf(rel) === undefined).length;
    }
  }
  const goneShards =
    base === undefined
      ? 0
      : Object.keys(base.root.shards).filter((s) => !shardFiles.has(s)).length;
  lap(`base, ${baseShards.size} shards read`);

  // The lint result store, per (file, version), for the files sent: which
  // syntactic parts already have a result under their current key. Each file
  // sends its stale syntactic groups (run with no program) and its typed parts
  // with the keys known for them — the worker, which alone knows the file's
  // result key, runs the ones whose key is not among them. A file with an
  // eslint directive is one unit and goes whole; whether it has one is in its
  // entry (or its base state), so only a text with neither — which is linted
  // anyway — is read here.
  const states = new Map<string, JobState>();
  const lintFiles: LintFileJob[] = [];
  let read = 0;
  for (const rel of jobPaths) {
    const v = version(rel);
    const stored = store.read(rel, v);
    const carried = same ? undefined : carriedOf(rel);
    let directive: boolean;
    if (stored !== undefined) directive = stored.directive;
    else if (carried !== undefined) directive = carried.d === 1;
    else {
      read++;
      directive = hasLintDirective(view.readText(rel));
    }
    const known =
      carried === undefined
        ? stored
        : unionEntry(stored, baseEntry(carried, base!.root.lint));
    const state: JobState = {
      version: v,
      directive,
      stored,
      known,
      reusedSyntactic: new Set(),
    };
    states.set(rel, state);
    const typed = { known: known?.typed ?? [] };
    if (directive) {
      lintFiles.push({
        file: join(root, rel),
        unit: "whole",
        syntactic: [],
        typed,
      });
      continue;
    }
    const knownSyntactic = new Set(known?.syntactic);
    const syntactic: string[] = [];
    for (const [g, fp] of groups.fps) {
      if (knownSyntactic.has(fp)) state.reusedSyntactic.add(fp);
      else syntactic.push(g);
    }
    lintFiles.push({
      file: join(root, rel),
      unit: "split",
      syntactic,
      typed,
    });
  }
  lap(`store reads, ${jobPaths.length} entries, ${read} texts read`);

  const movedRules = (): string => {
    if (base === undefined || same) return "";
    const l = base.root.lint;
    const g = Object.keys(lint.fps).filter((k) => l.fps[k] !== lint.fps[k]);
    const t = Object.keys(lint.typed).filter(
      (k) => l.typed[k] !== lint.typed[k],
    );
    return `, rules moved (${g.length} groups, ${t.length} typed parts)`;
  };
  const baseLine =
    base === undefined
      ? `base none (${choice.kind === "none" ? choice.reason : ""})`
      : `base ${base.label} ${base.treeHash.slice(0, 12)}${movedRules()}: ${changed} changed, ${removed} removed${goneShards > 0 ? ` (+${goneShards} shards gone)` : ""}; shards read ${baseShards.size}/${Object.keys(base.root.shards).length}; ${jobPaths.length}/${files.length} files sent`;

  const plan: Extract<Plan, { kind: "run" }> = {
    kind: "run",
    program,
    lintFiles,
    typedParts: { split: typedParts, whole: wholeParts },
    lintBase: base !== undefined && same ? base.hash : null,
    walkBase:
      base?.root.walk !== undefined
        ? { kind: "root", root: base.root.walk }
        : base !== undefined && same
          ? { kind: "none" }
          : { kind: "hint" },
    tree,
    phaseMs,
    baseLine,
  };

  async function finalize(
    outcome: ProgramOutcome | undefined,
  ): Promise<Finalized> {
    const t0 = performance.now();
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
    const lintLineOf = (tail: string): string => {
      // One greppable line: how much the worker linted, of which kinds, and
      // which parts are why — the instrument for "did that edit cost its
      // group, its importers, or the repo".
      const topStale = [...ran.byPart]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([g, n]) => `${g} ${n}`)
        .join(", ");
      return (
        `type-check: lint ${ran.files}/${files.length} files ` +
        `(${ran.whole} whole, ${ran.files - ran.whole} partial; ` +
        `syntactic ${ran.syntactic}, typed ${ran.typed}; ` +
        `${groups.fps.size} groups, engine ${groups.engineFiles} files)` +
        tail +
        (topStale ? ` — stale: ${topStale}` : "")
      );
    };
    // A crashed worker records nothing (its files re-lint next run, and no
    // base is written), and there is no verdict to assemble.
    if (outcome === undefined) {
      return {
        lintLine: lintLineOf(" — worker did not come back"),
        lintViolations: undefined,
        baseLine: "base not written (worker did not come back)",
      };
    }
    const keys = outcome.keys;
    if (keys === null) {
      return {
        lintLine: lintLineOf(" — worker keyed nothing"),
        lintViolations: undefined,
        baseLine: "base not written (worker keyed nothing)",
      };
    }

    const results = new Map<string, LintFileResult>();
    for (const r of outcome.lint) {
      const rel = toRel(root, r.file);
      if (results.has(rel)) {
        throw new Error(`type-check: the worker answered ${rel} twice`);
      }
      results.set(rel, r);
    }
    let storeWrites = 0;
    /** Write a file's per-file store entry when the merge changes it. */
    const record = (
      rel: string,
      v: string,
      stored: LintEntry | undefined,
      update: LintEntryUpdate,
    ): void => {
      const merged = mergeLintEntry(stored, update);
      if (stored !== undefined && sameEntry(stored, merged)) return;
      store.put(rel, v, merged);
      storeWrites++;
    };

    /**
     * A file's typed results under its result key `r`: each part ran (fresh)
     * or known under that key (reused) — anything else is a part nobody
     * linted, which the worker's own check should have refused.
     */
    const typedOf = (
      rel: string,
      directive: boolean,
      r: string,
      res: LintFileResult | undefined,
      known: LintEntry | undefined,
      fresh: Map<string, RawLintMessage[]>,
      reused: Set<string>,
    ): Record<string, RawLintMessage[]> => {
      const parts = directive ? wholeParts : typedParts;
      const keyed = parts.map((p) => ({
        group: p.group,
        key: typedResultKey(p.fp, r),
      }));
      const partKeys = new Set(keyed.map((p) => p.key));
      const ranByKey = new Map<string, RawLintMessage[]>();
      for (const p of res?.typed ?? []) {
        if (!partKeys.has(p.key)) {
          throw new Error(
            `type-check: the worker answered typed result ${p.key} (${p.group}) for ${rel}, which is no part of it under its result key`,
          );
        }
        if (p.kind === "ran") ranByKey.set(p.key, p.messages);
      }
      const out: Record<string, RawLintMessage[]> = {};
      for (const { group, key } of keyed) {
        const m = ranByKey.get(key);
        if (m !== undefined) {
          fresh.set(key, m);
          out[group] = m;
          count(typedLabel(group));
          continue;
        }
        if (!known?.typed.includes(key)) {
          throw new Error(
            `type-check: ${rel}'s typed part ${group} is stale under its result key and the worker did not lint it`,
          );
        }
        reused.add(key);
        out[group] = known.messages[key] ?? [];
      }
      return out;
    };
    const tally = (directive: boolean, syn: number, typedRan: number) => {
      if (syn === 0 && typedRan === 0) return;
      ran.files++;
      if (directive) {
        ran.whole++;
        ran.syntactic++;
        ran.typed++;
        return;
      }
      if (syn > 0) ran.syntactic++;
      if (typedRan > 0) ran.typed++;
      if (syn === groups.fps.size && typedRan === typedParts.length) {
        ran.whole++;
      }
    };

    // Every planned file's state, from what ran and what was known.
    const next = new Map<string, FileBase>();
    for (const [rel, st] of states) {
      const r = keys[rel];
      if (r === undefined) {
        throw new Error(
          `type-check: the worker gave ${rel} no result key, and the plan sent it`,
        );
      }
      const res = results.get(rel);
      results.delete(rel);
      if (
        res !== undefined &&
        res.unit !== (st.directive ? "whole" : "split")
      ) {
        throw new Error(
          `type-check: the worker linted ${rel} as ${res.unit}, which the plan did not`,
        );
      }
      const freshS = new Map<string, RawLintMessage[]>();
      const s: Record<string, RawLintMessage[]> = {};
      const answered = Object.keys(res?.syntactic ?? {});
      if (st.directive && answered.length > 0) {
        throw new Error(
          `type-check: the worker returned syntactic groups for directive file ${rel}`,
        );
      }
      for (const g of answered) {
        if (!groups.fps.has(g)) {
          throw new Error(
            `type-check: the worker returned lint group "${g}" for ${rel}, which the plan never asked for`,
          );
        }
      }
      if (!st.directive) {
        for (const [g, fp] of groups.fps) {
          const m = res?.syntactic[g];
          if (m !== undefined) {
            freshS.set(fp, m);
            s[g] = m;
            count(g);
          } else if (st.reusedSyntactic.has(fp)) {
            s[g] = st.known!.messages[fp] ?? [];
          } else {
            throw new Error(
              `type-check: ${rel}'s lint group "${g}" is stale and the worker did not lint it`,
            );
          }
        }
      }
      const freshT = new Map<string, RawLintMessage[]>();
      const reusedT = new Set<string>();
      const t = typedOf(rel, st.directive, r, res, st.known, freshT, reusedT);
      tally(st.directive, freshS.size, freshT.size);
      // Fresh results first, then the keys reused — or, for a text the store
      // has no entry for, its whole result, so the next run on this text in
      // any tree finds it.
      record(
        rel,
        st.version,
        st.stored,
        st.stored === undefined
          ? {
              directive: st.directive,
              syntactic: new Map(
                [...groups.fps]
                  .filter(() => !st.directive)
                  .map(([g, fp]) => [fp, s[g]!]),
              ),
              typed: new Map(
                (st.directive ? wholeParts : typedParts).map((p) => [
                  typedResultKey(p.fp, r),
                  t[p.group]!,
                ]),
              ),
              reusedSyntactic: new Set(),
              reusedTyped: new Set(),
              keepSyntactic,
              keepTyped,
            }
          : {
              directive: st.directive,
              syntactic: freshS,
              typed: freshT,
              reusedSyntactic: st.reusedSyntactic,
              reusedTyped: reusedT,
              keepSyntactic,
              keepTyped,
            },
      );
      next.set(rel, fileBase(st.version, st.directive, r, s, t));
    }

    // Every carried file whose result key moved: its syntactic results
    // stand, its typed parts are what the worker ran or reused for the new key.
    let movedKeys = 0;
    for (const [rel, r] of Object.entries(keys)) {
      if (states.has(rel)) continue;
      const b = same ? carriedOf(rel) : undefined;
      if (b === undefined) {
        throw new Error(
          `type-check: the worker keyed ${rel}, which the plan neither sent nor carried`,
        );
      }
      if (b.r === r) continue;
      movedKeys++;
      const res = results.get(rel);
      results.delete(rel);
      if (res !== undefined && Object.keys(res.syntactic).length > 0) {
        throw new Error(
          `type-check: the worker returned syntactic groups for carried file ${rel}`,
        );
      }
      const stored = store.read(rel, b.v);
      const freshT = new Map<string, RawLintMessage[]>();
      const reusedT = new Set<string>();
      const directive = b.d === 1;
      const t = typedOf(rel, directive, r, res, stored, freshT, reusedT);
      tally(directive, 0, freshT.size);
      record(rel, b.v, stored, {
        directive,
        syntactic: new Map(),
        typed: freshT,
        reusedSyntactic: new Set(),
        reusedTyped: reusedT,
        keepSyntactic,
        keepTyped,
      });
      next.set(rel, fileBase(b.v, directive, r, b.s ?? {}, t));
    }
    if (results.size > 0) {
      throw new Error(
        `type-check: the worker answered ${[...results.keys()].slice(0, 3).join(", ")}, which it was neither sent nor keyed`,
      );
    }
    const recordMs = performance.now() - t0;

    // ── The next base: the shards whose state changed, then the root ──
    const t1 = performance.now();
    const today = dayNumber();
    const shardsOut: Record<string, ShardRef> = {};
    const built = new Map<string, Record<string, FileBase>>();
    const touchedIds = new Set([...next.keys()].map(shardOf));
    let rebuilt = 0;
    let newShards = 0;
    let carriedShards = 0;
    let touched = 0;
    let lost: string | undefined;
    for (const [s, rels] of shardFiles) {
      const listing = listings.get(s)!;
      const prev = base?.root.shards[s];
      if (
        same &&
        prev !== undefined &&
        prev[1] === listing &&
        !touchedIds.has(s)
      ) {
        carriedShards++;
        if (today - prev[3] < TOUCH_AFTER_DAYS) {
          shardsOut[s] = prev;
          continue;
        }
        // Mark it used, so it outlives the root about to name it.
        if (!bases.touchShard(prev[0])) {
          if (prev[2] === 1) {
            throw new Error(
              `type-check: shard ${s} (${prev[0]}) holds lint messages and is no longer stored — no verdict can be assembled`,
            );
          }
          lost = s;
          continue;
        }
        touched++;
        shardsOut[s] = [prev[0], prev[1], prev[2], today];
        continue;
      }
      const shardFilesOut: Record<string, FileBase> = {};
      for (const rel of rels) {
        const f = next.get(rel) ?? carriedOf(rel);
        if (f === undefined) {
          throw new Error(
            `type-check: ${rel} has neither a state from this run nor one carried from the base`,
          );
        }
        shardFilesOut[rel] = f;
      }
      const { hash, wrote } = bases.putShard({ files: shardFilesOut });
      rebuilt++;
      if (wrote) newShards++;
      built.set(s, shardFilesOut);
      shardsOut[s] = [
        hash,
        listing,
        Object.values(shardFilesOut).some(hasMessages) ? 1 : 0,
        today,
      ];
    }
    let rootNote: string;
    if (lost !== undefined) {
      // A shard the base named is gone: this root cannot be completed from
      // what is in hand. The next run's base check refuses the old root too
      // and takes the full path, which writes a whole one.
      rootNote = `root NOT written: carried shard ${lost} is no longer stored`;
    } else {
      const nextRoot: RunBaseRoot = {
        format: RUN_BASE_FORMAT,
        treeHash,
        lint,
        overlay: tree.overlay,
        ...(outcome.walkRoot === null ? {} : { walk: outcome.walkRoot }),
        shards: shardsOut,
      };
      const { hash, wrote } = bases.putRoot(nextRoot);
      bases.setPointer(treeHash, hash);
      bases.setHint(worktree, treeHash);
      rootNote = `root ${hash.slice(0, 12)} ${wrote ? "written" : "kept"}`;
    }
    const baseMs = performance.now() - t1;

    // ── The lint verdict ──
    // Every file's results — fresh, known, or carried — under the
    // exemptions as they are NOW. Only a file holding a message, or naming a
    // file-level lint exemption (which is reported when it suppressed
    // nothing), can produce a line, so only those are assembled: the shards
    // the root marks as holding messages.
    const t2 = performance.now();
    const exemptions = await loadExemptions({
      root,
      glob: (pattern) => globPaths(view.files(), pattern),
    });
    const exemptionsMs = performance.now() - t2;
    const targets = new Set(
      exemptions.filter((e) => isLintRuleId(e.rule)).map((e) => e.target),
    );
    const messages = new Map<string, RawLintMessage[]>();
    let shardsRead = 0;
    for (const [s, ref] of Object.entries(shardsOut)) {
      if (ref[2] === 0) continue;
      let got = built.get(s) ?? baseShards.get(s);
      if (got === undefined) {
        const shard = bases.shard(ref[0]);
        if (shard === undefined) {
          throw new Error(
            `type-check: shard ${s} (${ref[0]}) holds lint messages and is no longer stored`,
          );
        }
        got = shard.files;
        shardsRead++;
      }
      for (const [rel, f] of Object.entries(got)) {
        if (hasMessages(f)) messages.set(rel, messagesOf(f));
      }
    }
    const subjects = files.filter(
      (rel) => messages.has(rel) || targets.has(rel),
    );
    const lintViolations = lintViolationLines(
      subjects.map((rel) => ({ rel, messages: messages.get(rel) ?? [] })),
      exemptions,
    ).join("\n");
    const verdictMs = performance.now() - t2 - exemptionsMs;

    const sec = (x: number): string => (x / 1000).toFixed(1);
    return {
      lintLine: `${lintLineOf("")} (finalize: records ${sec(recordMs)}s — ${states.size} planned, ${movedKeys} carried with a moved key, ${storeWrites} entries written; exemptions ${sec(exemptionsMs)}s, verdict ${sec(verdictMs)}s over ${subjects.length} files)`,
      lintViolations,
      baseLine: `base ${sec(baseMs)}s: shards ${rebuilt} rebuilt (${newShards} new), ${carriedShards} carried (${touched} touched), ${shardsRead} read for the verdict; ${rootNote}`,
    };
  }

  return { plan, finalize };
}
