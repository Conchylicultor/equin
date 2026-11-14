import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  installRepoView,
  openRepoView,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { sharedMemo } from "@plugins/packages/plugins/shared-work/core";

/**
 * One pass of the codegen tree family over a checkout: the file set its trees
 * and barrel evaluations read, handed down by the pass root that listed it.
 * Every memo of the family (the barrel-free tree, the web and all-runtime
 * evaluations, the slot namings, the enriched tree, the token groups) hangs
 * off the pass, so it lives exactly as long as the set it was read from — and
 * nothing in the family can list the working tree itself.
 *
 * Two kinds of pass, which differ only in what an evaluation phase reads:
 *
 * - a check run's ({@link codegenPassOver}): the run's one set, for every
 *   phase. Nothing writes during a check, so the set read at the start is the
 *   tree every phase sees.
 * - a writing pass ({@link writingCodegenPass}): the build, `regen-generated`.
 *   Each evaluation phase starts after an earlier one wrote generated files
 *   (the pre-barrel manifests, the post-web manifests), and its records are
 *   keyed by content — so a phase reads a snapshot re-taken by the pass root
 *   when it starts.
 */
export interface CodegenPass {
  /** Absolute checkout root. */
  readonly root: AppPath;
  /**
   * The pass's set as first listed: what the barrel-free tree (a pure function
   * of committed plugin source, which no phase rewrites) reads. Not what a
   * reader of generated files reads — that is {@link phaseRepo}, the set after
   * the pass's writes so far (the registry scans: `buildRegistryGenContext`).
   */
  readonly repo: RepoSnapshot;
  /** The set an evaluation phase reads, taken when the phase starts. */
  phaseRepo(): Promise<RepoSnapshot>;
}

/**
 * The pass over one fixed set (a check run's `ctx.repo()`), memoized on it:
 * every check of a run asking with the run's set shares its memos. An
 * input-keyed check's recording set is its own object (and its own input,
 * `markOwnInput`), so it gets its own pass, every read its trees make is
 * recorded, and the work is counted as that check's.
 */
export const codegenPassOver: (repo: RepoSnapshot) => CodegenPass = sharedMemo(
  "codegen pass",
  (repo) => {
    const phase = Promise.resolve(repo);
    return { root: repo.root, repo, phaseRepo: () => phase };
  },
);

/**
 * A writing pass: `repo` is the set the pass root listed first, `relist`
 * re-takes it for an evaluation phase (after the previous phase's writes).
 */
export function writingCodegenPass(
  repo: RepoSnapshot,
  relist: () => Promise<RepoSnapshot>,
): CodegenPass {
  return { root: repo.root, repo, phaseRepo: relist };
}

/**
 * A writing pass over the checkout at `root` for a process that has no repo
 * view of its own (`regen-generated`; `build` opens its view itself, as it
 * reads it outside codegen too): the view of the checkout (`openRepoView`),
 * installed so every writer's `noteRepoWrites` reaches it, as the pass's
 * phase set — each step reading generated files reads the set after the
 * pass's own writes, and a step after a no-op write the same set (so it shares
 * the earlier step's memos). `finish(fresh)` checks what every step was
 * answered against `fresh`, a snapshot the pass root takes once the pass is
 * done (a write that escaped the view fails by name, as in `build`), and
 * uninstalls the view.
 */
export async function openWritingCodegenPass(root: AppPath): Promise<{
  pass: CodegenPass;
  finish: (fresh: RepoSnapshot) => Promise<void>;
}> {
  const view = await openRepoView(root);
  installRepoView(view);
  return {
    pass: writingCodegenPass(await view.current(), () => view.current()),
    finish: async (fresh) => {
      try {
        await view.assertAgrees(fresh);
      } finally {
        installRepoView(undefined);
      }
    },
  };
}
