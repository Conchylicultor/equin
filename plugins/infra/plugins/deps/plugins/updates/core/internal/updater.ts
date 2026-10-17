/**
 * An updater: how one kind of pinned input moves to newer releases — the mise
 * toolchain (`mise.lock`), every `python/` project's `uv.lock`, later
 * `bun.lock`. The generic runner (`runUpgrade`) owns everything around the move:
 * the gates before and after, retry-to-confirm, the verdict, putting the files
 * back on a regression, the task text and the push permission. An updater only
 * says what is outdated, what to move, how to move it, and what extra smoke
 * tests the moved things must pass.
 */

import type { Hold } from "./hold";

/** One command a moved input must still pass, beyond the check and test suites. */
export interface UpdaterSmoke {
  /** Stable name — the identity a failure is compared by, before and after. */
  name: string;
  argv: readonly string[];
  /** Repo-relative working directory; the repo root when omitted. */
  cwd?: string;
  /** Extra environment on top of the gates' own. */
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
}

/**
 * Why a newer release is reported but not moved to by this upgrade.
 *
 * `held`: a hold the updater honours until `until` (a date at most 90 days out
 * when it was set) — reported so a hold is never silent, and inert once it
 * expires. `blocked`: a move the updater cannot make on its own (a lockstep
 * group whose members have not all published the release, a patched package
 * whose patch must be ported) — `prerequisite` is the work that unblocks it,
 * which the upgrade task asks for.
 */
export type OutdatedWaiting =
  | { kind: "held"; reason: string; until: string }
  | { kind: "blocked"; prerequisite: string };

/** Something newer than what the lock records, as the scheduled detection sees it. */
export interface Outdated {
  name: string;
  /** `null` when nothing is recorded yet (a newly declared tool). */
  current: string | null;
  latest: string;
  /** Present when this upgrade will not move it; see {@link OutdatedWaiting}. */
  waiting?: OutdatedWaiting;
}

/**
 * Whether a detected row is work for an upgrade task: a move it makes, or a
 * blocked one whose prerequisite it does. A held row only rides along.
 */
export function isActionable(o: Outdated): boolean {
  return o.waiting?.kind !== "held";
}

/** One input the upgrade moves. `from` is `null` for an input added fresh. */
export interface Move {
  name: string;
  from: string | null;
  to: string;
  /**
   * Moves sharing a unit land together or not at all (a lockstep group): when
   * the runner narrows a regressed batch down, it never splits one. Absent: the
   * move is a unit of its own.
   */
  unit?: string;
}

export interface Updater {
  /** Stable id: `./singularity deps upgrade <id>`, the receipt name, the task author. */
  readonly id: string;
  /** One line: what it keeps current. */
  readonly description: string;
  /**
   * The repo-relative files `apply` may rewrite. The runner snapshots them
   * before the move and puts them back (then calls `sync`) on any outcome
   * that lands nothing; on `partial` they hold exactly the landed moves.
   */
  files(root: string): Promise<readonly string[]>;
  /**
   * Work before planning that is part of the upgrade but has no lock entry (mise
   * updates itself). Returns notes recorded on the receipt.
   */
  prepare?(
    root: string,
    log: (line: string) => void,
  ): Promise<Readonly<Record<string, string>>>;
  /**
   * The scheduled, read-only question asked on main: is anything newer (and not
   * held)? Installs nothing, moves nothing.
   */
  detect(root: string): Promise<Outdated[]>;
  /**
   * The exact moves an upgrade would make now, restricted to `only` (names this
   * updater knows; an unknown one throws). Read-only.
   */
  plan(root: string, only: readonly string[] | undefined): Promise<Move[]>;
  /** Make the moves in `root`'s files. Throws on any failure. */
  apply(
    root: string,
    moves: readonly Move[],
    log: (line: string) => void,
  ): Promise<void>;
  /**
   * Bring what is installed or derived in `root` back in line with `files` as
   * they are NOW (npm: `node_modules` and the generated files formatted through
   * a moved package). The runner calls it after every put-back, so a regressed
   * or aborted upgrade leaves nothing running on releases nothing proved. An
   * updater whose installs live side by side, keyed by the lock, has nothing
   * to do — and says why.
   */
  sync(root: string, log: (line: string) => void): Promise<void>;
  /** The smoke tests the moved inputs must pass, run before and after the move. */
  smoke(root: string, moves: readonly Move[]): Promise<readonly UpdaterSmoke[]>;
  /** Where this updater's holds (releases skipped on purpose) live, and what they are. */
  readonly holds: {
    /** Repo-relative file the agent adds a hold to, or where to find them. */
    readonly file: string;
    /**
     * Every hold declared, expired ones included. The runner and the detect job
     * refuse a hold set past its bound ({@link holdProblems}) before planning.
     */
    read(root: string): Promise<readonly Hold[]>;
  };
}
