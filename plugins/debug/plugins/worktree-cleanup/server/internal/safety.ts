import { GIT } from "@plugins/infra/plugins/paths/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

export interface GitHygiene {
  unpushedCount: number;
  isDirty: boolean;
}

// The conservative answer: "assume there is something to lose". Returned for
// EVERY path where we failed to establish otherwise, so a hygiene probe that
// could not run can never certify a worktree as safe to delete.
//
// `isDirty: true` alone is enough to fail `isSafeToReap`; the sentinel
// unpushedCount makes the reason legible in the UI rather than reading as a
// genuinely clean tree.
const HYGIENE_UNKNOWN: GitHygiene = { unpushedCount: 1, isDirty: true };

/**
 * PURE helper (exported for unit testing): classify `git status --porcelain=v2
 * --branch` output. Split out from the spawn so the parsing — which is where the
 * fail-open bugs lived — is directly testable.
 *
 * Returns the conservative HYGIENE_UNKNOWN when the output does not prove the
 * tree is clean and published:
 *
 *   - No `# branch.oid` header ⇒ this is not parseable status output at all
 *     (empty stdout from a failed git, a truncated read). Previously an empty
 *     string sailed through as `{unpushedCount: 0, isDirty: false}` — "clean,
 *     nothing unpushed", the maximally-reapable answer.
 *   - No `# branch.ab` header ⇒ the branch has NO UPSTREAM. git only emits that
 *     line when a tracking branch exists, so a never-pushed branch produced no
 *     match and read as 0 unpushed. Every commit on such a branch exists ONLY in
 *     that worktree, which is the strongest possible reason not to delete it.
 */
export function classifyGitStatus(statusOut: string): GitHygiene {
  const lines = statusOut.split("\n");

  // `# branch.oid` is emitted unconditionally by --porcelain=v2 --branch, so its
  // absence means we are not looking at valid status output.
  if (!lines.some((l) => l.startsWith("# branch.oid "))) return HYGIENE_UNKNOWN;

  // Any non-header line is a file change.
  const isDirty = lines.some((l) => l.length > 0 && !l.startsWith("#"));

  // Header line: "# branch.ab +<ahead> -<behind>". Emitted ONLY when the branch
  // has an upstream — no upstream means nothing has been published anywhere.
  const abLine = lines.find((l) => l.startsWith("# branch.ab "));
  if (!abLine)
    return { unpushedCount: HYGIENE_UNKNOWN.unpushedCount, isDirty: true };

  const aheadMatch = abLine.match(/\+(\d+)/);
  if (!aheadMatch) return HYGIENE_UNKNOWN;

  return { unpushedCount: parseInt(aheadMatch[1]!, 10), isDirty };
}

// A `git status` over a 690 MB checkout is a CPU/IO-heavy read (measured ~0.4 s
// warm, ~0.95 s cold), so the whole probe is one admitted, bounded, attributed
// unit — and every caller gets all three by calling this function, because the
// three wrappers live HERE rather than at the call sites:
//
//   1. `runTracked` — the probe is a first-class `bg` entry span. Without it the
//      reap job's git fan-out was 100% unattributed self-time: 200 captured
//      traces all read `childMs: 0` for a job that spends its life in git.
//   2. `withHeavyReadSlot` — the host-wide heavy-read budget (4 slots). Both
//      callers used to fan out unadmitted (the reaper 24-wide, the UI list
//      handler 50-wide), oversubscribing the host's entire sanctioned read
//      budget several times over from a background sweep.
//   3. `timeoutMs` — a wedged `git status` now fails in bounded time instead of
//      hanging the sweep (and, through it, the host-wide worktree-mutate flock).
//
// `background: true` demotes the child via taskpolicy; the reaper passes it (its
// probes must yield to interactive backends), the UI list handler does not (a
// human is waiting on it).
//
// FAILURE IS CONSERVATIVE, and the non-zero-exit check is the load-bearing half:
// `spawnCaptured` reports a failed command as a RESULT (`exitCode !== 0`,
// `timedOut: true`) rather than throwing, so a failed `git status` would
// otherwise reach `classifyGitStatus` with empty stdout — which is exactly the
// input that used to parse as "clean, 0 unpushed", the maximally-reapable
// answer. All three arms (throw, timeout, non-zero exit) funnel into
// HYGIENE_UNKNOWN.
export async function getGitHygiene(
  wtPath: string,
  opts: { background?: boolean } = {},
): Promise<GitHygiene> {
  return runTracked("worktree-cleanup:hygiene", () =>
    withHeavyReadSlot(async () => {
      try {
        const r = await spawnCaptured(
          [
            GIT,
            "--no-optional-locks",
            "-C",
            wtPath,
            "status",
            "--porcelain=v2",
            "--branch",
          ],
          {
            timeoutMs: 30_000,
            tier: opts.background ? "background" : "inherit",
          },
        );
        if (r.timedOut || r.exitCode !== 0) return HYGIENE_UNKNOWN;
        return classifyGitStatus(r.stdout);
        // eslint-disable-next-line promise-safety/no-bare-catch -- git spawn can fail for many reasons (binary missing, worktree deleted mid-flight, not a git repo); all map to the same conservative safe default (assume dirty = not safe to delete), so every error is correctly handled here
      } catch {
        return HYGIENE_UNKNOWN;
      }
    }),
  );
}

// Allowlist of task statuses known to have no live agent session AND nothing the
// user still means to come back to. Intentionally explicit: unknown/future
// statuses default to not-safe.
//
// `held` is excluded ON PURPOSE, and is not an oversight to "fix": holding is the
// user parking work they intend to resume, so its worktree must survive the clean
// path however long it idles. Only the hard floor in reap-policy (90d) can take a
// held worktree. The mirror of this rule on the transcript side is
// `listRetainedConversations` (conversations/transcript-retention).
const DELETABLE_TASK_STATUSES = new Set(["done", "dropped"]);

export function isTaskDeletable(status: string | undefined): boolean {
  return status ? DELETABLE_TASK_STATUSES.has(status) : true;
}

export const SAFE_REAP_AGE_MS = 72 * 60 * 60 * 1000;

export interface SafetyInput {
  dirExists: boolean;
  dbPresent: boolean;
  unpushedCount: number;
  isDirty: boolean;
  taskDeletable: boolean;
  ageMs: number;
  // "The user has not explicitly finished with this attempt" — attempts_v.retained
  // (the has_open_conv rollup, `conversation.status <> 'done'`). NOT
  // attempts_v.active: that is the progress notion, and a conversation whose pane
  // was killed to reclaim resources reads inactive while still being fully
  // resumable. Pass `false` only where there is no attempt to speak for (a dir
  // orphan with no row at all).
  retained: boolean;
}

// Single definition of "nothing to lose, safe to auto-reap". Used by both the
// UI safe-to-delete badge (handle-list) and the scheduled reaper (reap-policy),
// so the two can never drift again.
//
// Reapability is USER INTENT, never process liveness. Two independent proofs that
// the user is finished are required, and they are checked before anything else:
//   - `retained` false — every conversation on the attempt was explicitly closed
//     (`exit_clean` / the UI Exit actions are the only writers of `done`).
//   - `taskDeletable` — the task itself is done or dropped (`held` excluded).
// A dormant agent proves neither. This ordering is why the guard now also covers
// the orphan branch below: a checkout that vanished while its conversation is
// still open leaves the fork DB as the only copy of that attempt's state, so
// dropping it would finish destroying work the user can still ask for.
export function isSafeToReap(i: SafetyInput): boolean {
  if (i.retained) return false; // the user has not finished with this — never reap
  if (!i.dirExists && i.dbPresent) return true; // orphan: nothing to lose, just drop the DB
  return (
    i.dirExists &&
    i.unpushedCount === 0 &&
    !i.isDirty &&
    i.taskDeletable &&
    i.ageMs >= SAFE_REAP_AGE_MS
  );
}

// Whether running the git hygiene probe can still change the reaper's verdict for
// a NON-retained attempt whose worktree dir is present. Lives here, directly
// under the conjunction it is derived from, so the short-circuit and the
// predicate cannot drift apart in separate files.
//
// The reaper's verdict is `isSafeToReap(...) || hardFloor`. With `retained: false`
// and `dirExists: true`, `isSafeToReap` reduces to
// `clean && taskDeletable && ageMs >= SAFE_REAP_AGE_MS`, where `clean`
// (`unpushedCount === 0 && !isDirty`) is the ONLY term the subprocess supplies.
// So:
//   - `hardFloor`                    ⇒ verdict is true whatever git says ⇒ no probe
//   - `!taskDeletable` or too young  ⇒ verdict is false whatever git says ⇒ no probe
//   - otherwise                      ⇒ the verdict IS `clean` ⇒ probe required
//
// This is a REORDERING, not a policy change: the probe is skipped only where its
// answer is provably ignored. The property test in safety.test.ts pins that —
// if `isSafeToReap` ever grows a term that reads hygiene outside this window,
// the test fails rather than the reaper silently starting to trust a stale
// conservative default.
export function needsHygiene(i: {
  hardFloor: boolean;
  taskDeletable: boolean;
  ageMs: number;
}): boolean {
  return !i.hardFloor && i.taskDeletable && i.ageMs >= SAFE_REAP_AGE_MS;
}
