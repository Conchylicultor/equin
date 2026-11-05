import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";

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
   * The pass's set: what the barrel-free tree (a pure function of committed
   * plugin source, which no phase rewrites) and the registry scans read.
   */
  readonly repo: RepoSnapshot;
  /** The set an evaluation phase reads, taken when the phase starts. */
  phaseRepo(): Promise<RepoSnapshot>;
}

// One pass per check run's set: every check of a run asking with the run's set
// shares its memos. An input-keyed check's recording set is its own object, so
// it gets its own pass, and every read its trees make is recorded.
const passesBySet = new WeakMap<RepoSnapshot, CodegenPass>();

/** The pass over one fixed set (a check run's `ctx.repo()`), memoized on it. */
export function codegenPassOver(repo: RepoSnapshot): CodegenPass {
  let pass = passesBySet.get(repo);
  if (pass === undefined) {
    const phase = Promise.resolve(repo);
    pass = { root: repo.root, repo, phaseRepo: () => phase };
    passesBySet.set(repo, pass);
  }
  return pass;
}

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
