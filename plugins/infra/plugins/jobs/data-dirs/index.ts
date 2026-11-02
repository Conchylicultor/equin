import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Durable state the jobs plugin must carry ACROSS its own process exits.
 *
 * Today that is exactly one thing: the exit latch, one small JSON file per
 * worktree recording when this worktree's backend last exited on purpose: the
 * runner serving the longest hold class ran out of usable slots, or a runner
 * died. Three such exits within an hour suppress the fourth — the backend files its report and
 * stays up instead, because an automatic restart that fixes nothing is worse
 * than an honest wedge.
 *
 * **READ THIS BEFORE PATTERN-MATCHING THE TIMESTAMPS ONTO THE BANNED LEASE.**
 * This plugin bans duration-based liveness inference outright (see the top of
 * `jobs/CLAUDE.md`): "this row has been locked T, so its owner is dead, so I may
 * re-dispatch it" cost ~25 stolen live jobs in 8 days. The hour in this file is
 * a different kind of claim entirely, and the difference is not a matter of
 * degree:
 *
 * - It governs OUR OWN RESTART POLICY — "have I already exited three times this
 *   hour" — and nothing else. It is a fact about this process's history, which
 *   this process is the sole authority on.
 * - **It makes no claim about whether any worker is alive**, and no code reads
 *   it to decide one. Liveness is still answered exactly where it was: by
 *   Postgres, through the advisory lock in `pg_locks`. A stale, corrupt, or
 *   deleted file changes only how many times we are willing to exit; it can
 *   never move a job row, release a lock, or let a handler be re-dispatched.
 *
 * The gateway does **not** auto-respawn an exited backend
 * (`gateway/worktree.go`'s `onBackendExit` clears `w.active` and sets
 * `StateIdle`; only the next proxied request calls `Ensure`, which spawns from
 * Idle) — so a floor-crash loop is paced by real traffic rather than by a
 * supervisor, and is far slower than the design originally assumed. That is
 * also why the latch is small rather than elaborate: it is a backstop against a
 * pathological case, not the primary brake. Exiting remains strictly better
 * than staying up with the widest runner dead — teardown drops every advisory
 * lock, the next boot's sweeper reclaims cleanly, and the work re-runs.
 */
export const jobsStateDir = defineDataDir({
  kind: "state",
  name: "jobs",
  owner: "infra/jobs",
  description:
    "Job-worker state that must survive a process exit (one file per worktree): the floor-crash latch that suppresses a fourth deliberate exit within an hour",
  // Deleting the file re-arms the exit budget: a worktree that has already
  // exited three times this hour would be willing to exit again. That costs an
  // extra restart of a backend whose widest runner is already dead — a real but
  // small cost, and never a correctness one (nothing infers liveness from it).
  // A file older than a day cannot influence an hour-wide window, so past that
  // point it is pure residue.
  reclaim: { kind: "ttl", ttlDays: 1 },
});

export default [jobsStateDir];
