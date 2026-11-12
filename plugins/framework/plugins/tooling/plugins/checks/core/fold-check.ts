import {
  foldRepoFiles,
  type FileFold,
  type FoldContext,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import type {
  Check,
  CheckContext,
  CheckResult,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";

/**
 * The run's file set without its bytes: paths, membership and blob ids. What a
 * fold check's selection and verdict see — every byte a fold check reads goes
 * through its fold, so it is read once per blob the store has not folded yet.
 */
export type RepoPaths = Omit<RepoSnapshot, "read">;

/** A fold check's context outside its fold: the check context, its file set without `read`. */
export type FoldVerdictContext = Omit<CheckContext, "repo"> & {
  repo(): Promise<RepoPaths>;
};

/**
 * A check whose per-file work is a fold (`plugin-records`' `FileFold`): each
 * file judged on its own bytes, the parts combined into one small answer, and
 * the verdict decided from that answer and the file paths alone.
 *
 * The fold's records are kept along the directory tree, so a pass after an
 * edit reads and judges only the edited files — every other directory is one
 * record — and a cold store reads each selected file once, as a whole-tree
 * `run` would. That makes the check's cost O(changes) by its shape: the
 * selection and the verdict are handed no `read`, so the only bytes the check
 * reads are the fold's.
 *
 * - `files` — which files the fold covers, chosen from the paths and the
 *   context alone (files out of the check's `outOfScope` categories are
 *   dropped before folding).
 * - `context` — plain data every file's part also reads (the plugin set, …),
 *   part of every record's key: a change to it re-folds every file. It may
 *   read through the full context (a shared, memoized input such as the
 *   plugin tree), and must stay small.
 * - `facts` — what the verdict alone reads that the paths do not say (a
 *   shared, memoized input such as the collected-dir set), not part of any
 *   key. Like `context`, never a walk of its own over the files' bytes: that
 *   is what the fold is for.
 * - `fold` — the per-file part and how parts combine, in a `*.scan.ts`
 *   module of its own (its import closure keys the records).
 * - `verdict` — the cross-file rules, over the folded answer and the paths.
 *
 * An input-keyed fold check stays sound with no read-set code of its own:
 * keying a file's record takes its blob id from the recording file set, which
 * records the file's content as a fact of the read-set.
 */
export interface FoldCheck<C extends FoldContext, F, V> extends Omit<
  Check,
  "run"
> {
  context(ctx: CheckContext): C | Promise<C>;
  files(repo: RepoPaths, context: C): readonly string[];
  facts(ctx: CheckContext): V | Promise<V>;
  fold: FileFold<C, F>;
  verdict(
    folded: F,
    inputs: { context: C; facts: V },
    ctx: FoldVerdictContext,
  ): CheckResult | Promise<CheckResult>;
}

/** The file set without `read`, at runtime as in its type. */
function pathsOf(repo: RepoSnapshot): RepoPaths {
  return {
    root: repo.root,
    all: () => repo.all(),
    has: (path) => repo.has(path),
    under: (dir) => repo.under(dir),
    glob: (pattern) => repo.glob(pattern),
    blobOf: (path) => repo.blobOf(path),
  };
}

/** A `Check` from a fold check: the runner sees an ordinary check. */
export function defineFoldCheck<C extends FoldContext, F, V = null>(
  spec: FoldCheck<C, F, V>,
): Check {
  const { files, context, facts, fold, verdict, ...check } = spec;
  return {
    ...check,
    async run(ctx) {
      const repo = await ctx.repo();
      const paths = pathsOf(repo);
      const verdictCtx: FoldVerdictContext = {
        ...ctx,
        repo: () => Promise.resolve(paths),
      };
      const data = await context(ctx);
      const selected = files(paths, data).filter((f) => ctx.inScope(f));
      const folded = await foldRepoFiles(repo, selected, fold, data);
      return verdict(
        folded,
        { context: data, facts: await facts(ctx) },
        verdictCtx,
      );
    },
  };
}
