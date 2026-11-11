import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
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
 * Who a newer release waits on, as facts — never prose: `formatOutdated` is the
 * one place that writes them as text, and `awaitingOrBlocked` the one place
 * that decides when a wait has gone on too long.
 */
export type AwaitingOn =
  /**
   * Someone else must publish `release` first: a lagging lockstep partner, or
   * the package we build from. `since`: when what we wait to catch up with
   * became available (ISO instant) — past `AWAIT_MAX_DAYS` of it the
   * wait is BLOCKED (see `awaitingOrBlocked`).
   */
  | { kind: "publish"; by: readonly string[]; release: string; since: string }
  /**
   * Published; the partners are inside the cooldown until `until` (ISO
   * instant). Bounded by construction: it never escalates.
   */
  | { kind: "cooldown"; of: readonly string[]; until: string };

/**
 * Why a newer release is reported but not moved to by this upgrade.
 *
 * `held`: a hold covers it — honoured until a diff deletes it, whatever its
 * date. `reviewBy` is when it must be looked at again; `lapsed` once that has
 * passed (the hold itself is then work for the upgrade task, listed under
 * "Holds to review", and the runner refuses to finish past it). `blocked`: a
 * move the updater cannot make on its own (a lockstep group whose members have
 * not all published the release, a patched package whose patch must be
 * ported) — `prerequisite` is the work that unblocks it, which the upgrade
 * task asks for. `awaiting`: someone else must publish first (a lockstep
 * partner that has not released it yet, or has and is still in its cooldown;
 * an upstream release the package we build from has not shipped) — `on` says
 * who and what, see {@link AwaitingOn}. Nothing for an upgrade task to do: the
 * row rides along, like a held one, and moves on its own once they have — for
 * at most `AWAIT_MAX_DAYS` of a publish wait, after which the detection
 * reports it BLOCKED (`boundedRows`), so a third party that never publishes
 * cannot pin us silently.
 */
export type OutdatedWaiting =
  | { kind: "held"; reason: string; reviewBy: string; lapsed: boolean }
  | { kind: "blocked"; prerequisite: string }
  | { kind: "awaiting"; on: AwaitingOn };

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
 * blocked one whose prerequisite it does. A held or awaiting row only rides
 * along.
 */
export function isActionable(o: Outdated): boolean {
  return o.waiting === undefined || o.waiting.kind === "blocked";
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

/**
 * How an upgrade treats an updater's release cooldown (the days a release must
 * have been public before it is adopted — the cheapest defence against a
 * hijacked fresh release). `honour`: the default, and the only one the
 * scheduled detection uses. `skip`: adopt the newest release however fresh
 * (`./equin deps upgrade --skip-cooldown`), for an update wanted now — the
 * gates still prove every move. An updater with no cooldown ignores it.
 */
export type Cooldown = "honour" | "skip";

/**
 * What `Updater.plan` answers for its selection (`PlanOptions.only`, widened
 * to the lockstep partners of every name in it — they move together, so they
 * wait together too).
 */
export interface UpdaterPlan {
  /** The exact moves an upgrade makes now. */
  moves: Move[];
  /**
   * Every newer release of the selection, as `detect` reports it but under the
   * plan's cooldown — so a skipped cooldown lists no cooldown wait. The rows
   * carrying a `waiting` are the releases this upgrade does not take; the
   * runner lists them on the receipt, so a run that moves nothing never reads
   * as "on its latest release" while a release cools down, is held or waits.
   */
  outdated: Outdated[];
}

/** What `Updater.plan` is asked for. */
export interface PlanOptions {
  /** Names this updater knows to restrict the plan to (an unknown one throws); every outdated input when undefined. */
  only: readonly string[] | undefined;
  cooldown: Cooldown;
}

export interface Updater {
  /** Stable id: `./equin deps upgrade <id>`, the receipt name, the task author. */
  readonly id: string;
  /** One line: what it keeps current. */
  readonly description: string;
  /**
   * The repo-relative files `apply` may rewrite. The runner snapshots them
   * before the move and puts them back (then calls `sync`) on any outcome
   * that lands nothing; on `partial` they hold exactly the landed moves.
   */
  files(root: AppPath): Promise<readonly string[]>;
  /**
   * Work before planning that is part of the upgrade but has no lock entry (mise
   * updates itself). Returns notes recorded on the receipt.
   */
  prepare?(
    root: AppPath,
    log: (line: string) => void,
  ): Promise<Readonly<Record<string, string>>>;
  /**
   * The scheduled, read-only question asked on main: is anything newer (and not
   * held)? Installs nothing, moves nothing.
   */
  detect(root: AppPath): Promise<Outdated[]>;
  /**
   * The exact moves an upgrade would make now and what else is newer,
   * restricted to `opts.only` (and its lockstep partners), under
   * `opts.cooldown`. Read-only.
   */
  plan(root: AppPath, opts: PlanOptions): Promise<UpdaterPlan>;
  /**
   * Make the moves in `root`'s files, under the `cooldown` they were planned
   * with (an updater that re-resolves — uv — must not drop a fresh release the
   * plan took). Throws on any failure.
   */
  apply(
    root: AppPath,
    moves: readonly Move[],
    log: (line: string) => void,
    cooldown: Cooldown,
  ): Promise<void>;
  /**
   * Bring what is installed or derived in `root` back in line with `files` as
   * they are NOW (npm: `node_modules` and the generated files formatted through
   * a moved package). The runner calls it after every put-back, so a regressed
   * or aborted upgrade leaves nothing running on releases nothing proved. An
   * updater whose installs live side by side, keyed by the lock, has nothing
   * to do — and says why.
   */
  sync(root: AppPath, log: (line: string) => void): Promise<void>;
  /** The smoke tests the moved inputs must pass, run before and after the move. */
  smoke(
    root: AppPath,
    moves: readonly Move[],
  ): Promise<readonly UpdaterSmoke[]>;
  /** Where this updater's holds (releases skipped on purpose) live, and what they are. */
  readonly holds: {
    /** Repo-relative file the agent adds a hold to, or where to find them. */
    readonly file: string;
    /**
     * Every hold declared, lapsed ones included. The runner and the detect job
     * read it before planning (`reviewableHolds`): a hold set past its bound
     * throws, and a lapsed one is work the upgrade must do first.
     */
    read(root: AppPath): Promise<readonly Hold[]>;
  };
}
