import { join } from "path";

/**
 * The repo's ONE TypeScript program.
 *
 * There used to be a `TscTarget[]` here, discovered by scanning
 * `plugins/framework/plugins/*` for a `tsconfig.json` and adding the two
 * root-level projects (`tsconfig.tools.json`, `tsconfig.test.json`) — seven
 * programs, each spelled as a `tsc` COMMAND LINE (`dir` + `args`), which every
 * spawner then had to decode a `-p` back out of. Measured, the seven held
 * 30,649 file instances for 8,252 distinct repo files, and six of them loaded
 * the identical type environment: the split bought no type-environment
 * isolation, only 3.7 checks of the average file per cold miss. So there is one
 * program, named by its tsconfig FILE, and no list to iterate.
 * See research/2026-09-18-global-type-check-one-program.md.
 */
export interface TscProgram {
  /**
   * The program's name. Used for its manifest's filename, its program-key
   * records and its transcript lines — so it is a stable literal, not
   * something derived from a path that varies per worktree.
   */
  name: string;
  /** Absolute path of the tsconfig the worker builds. */
  tsconfigPath: string;
}

export function repoProgram(root: string): TscProgram {
  return { name: "repo", tsconfigPath: join(root, "tsconfig.json") };
}
