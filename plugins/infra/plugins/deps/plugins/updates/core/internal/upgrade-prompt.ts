import { describeHold, type Hold } from "./hold";
import { isActionable, type Outdated } from "./updater";

/** One updater's share of an upgrade task: what it found outdated, and the holds it must review. */
export interface OutdatedUpdater {
  updaterId: string;
  outdated: readonly Outdated[];
  /** Holds past their `reviewBy`: work for this task, whether or not a row is outdated. */
  lapsed: readonly Hold[];
  /** Repo-relative file where a hold for this updater is added. */
  holdsFile: string;
}

/** Whether an updater's share is work for an upgrade task: a move to make or a hold to review. */
export function hasUpgradeWork(u: OutdatedUpdater): boolean {
  return u.lapsed.length > 0 || u.outdated.some(isActionable);
}

/** The title of the batched upgrade task: its actionable rows and its holds to review. */
export function upgradeTaskTitle(batch: readonly OutdatedUpdater[]): string {
  return `Upgrade ${batch
    .filter(hasUpgradeWork)
    .map((u) => {
      const moves = u.outdated
        .filter(isActionable)
        .map((o) => `${o.name} ${o.current ?? "(new)"} → ${o.latest}`);
      const review = u.lapsed.map(
        (h) => `review hold on ${h.names.join(", ")}`,
      );
      return `${u.updaterId}: ${[...moves, ...review].join(", ")}`;
    })
    .join("; ")}`;
}

function formatOutdated(o: Outdated): string {
  const move = `${o.name} ${o.current ?? "(new)"} → ${o.latest}`;
  switch (o.waiting?.kind) {
    case undefined:
      return move;
    case "held":
      return o.waiting.lapsed
        ? `${move} — HELD, REVIEW OVERDUE since ${o.waiting.reviewBy}: ${o.waiting.reason}`
        : `${move} — HELD (review by ${o.waiting.reviewBy}): ${o.waiting.reason}`;
    case "blocked":
      return `${move} — BLOCKED, do this first: ${o.waiting.prerequisite}`;
  }
}

/**
 * The \`{{outdated}}\` variable of the upgrade prompt: each updater with work, the
 * file its holds live in, every release move it found, and every hold whose
 * review is overdue.
 */
export function outdatedSections(batch: readonly OutdatedUpdater[]): string {
  return batch
    .map((u) => {
      const rows = u.outdated.map((o) => `- ${formatOutdated(o)}`);
      const review =
        u.lapsed.length === 0
          ? []
          : [
              "Holds to review:",
              ...u.lapsed.map((h) => `- [ ] ${describeHold(h)}`),
            ];
      return [
        `\`${u.updaterId}\` (holds in \`${u.holdsFile}\`):`,
        ...rows,
        ...review,
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * The default prompt template of the batched upgrade task — what the build
 * commits as the Dependency upgrades config's `prompt`. Fixed steps: the agent
 * never improvises the gate, it runs the one command that implements it.
 * `{{pushPolicy}}` is what the automation's Push setting allows, scoped by
 * step 2 to an `upgraded` or `partial` verdict and an `ok` build.
 */
export const DEPS_UPGRADE_PROMPT = `Newer releases are available, or holds are due for review (seen on main by the Dependency upgrades
automation):

{{outdated}}

Move this worktree to them, all in this one task. You own proving it works.

First, the holds to review (listed above, per updater): \`./singularity deps upgrade\` refuses to run (verdict
   \`holds-to-review\`) while any hold is past its \`reviewBy\`, and this task is not done until each one is
   resolved. A hold is never released by its date — only you lift it. For each:
   - Check whether its reason still stands: the upstream issue, the release notes of every release since, and —
     if the check and test suites do not exercise what broke — exercise it directly.
   - Lift it if the reason is gone: delete the hold (fix our side first if the bug is ours). The upgrade then moves
     the release through the gates; if it regresses after all, put the hold back with what you learned.
   - Renew it if the reason still stands: a new \`reviewBy\` at most 90 days out and a \`reason\` that says what you
     checked and when.
   Also delete any hold whose release a newer one has already moved past — it holds nothing any more.

1. Run \`./singularity deps upgrade\` (in the background — it runs the full check and test suites at least twice).
   With no updater named it moves EVERY updater together, behind one baseline: it compares every check, test and
   the moved inputs' smoke tests on the current releases against the new ones. When something regresses it narrows
   the batch down on its own (a lockstep group is never split), keeps every release that passes, and names each
   release responsible. Its verdict is in \`deps-upgrade.json\` in this worktree's data dir (the command prints the
   path): \`landed\`, \`culprits\` (each with what it broke), \`untested\`, and \`blind\` (what already fails without
   any upgrade — file it with \`add_task\`, it is not this task's to fix).

2. Verdict \`upgraded\` or \`partial\`: the files now hold exactly the \`landed\` releases. Run \`./singularity build\`
   and confirm \`build-status.json\` says \`ok\`. Then:
   {{pushPolicy}}
   A push's message names the landed moves: \`chore(deps): <updater> <name> <from> → <to>, …\`. Any authorization to
   push covers the lock moves and any fix or hold you made for them, nothing else. On \`partial\`, go on to step 3
   for the culprits after pushing; \`untested\` releases are left to the next upgrade.

3. Each culprit (verdict \`partial\` or \`regressed\`; on \`regressed\` every file was put back):
   - If the bug is ours (code relying on old behavior), fix it.
   - If it is upstream, find or file the upstream issue, then add a hold for that release in that updater's holds
     file (listed above) with the reason, the issue URL and a \`reviewBy\` date at most 90 days out.
   - If it breaks only without another release it depends on, declare the two as one lockstep group.
   Then run \`./singularity deps upgrade\` again, and go back to step 2 on its verdict.

4. Verdict \`current\`: nothing to do. Everything is already on its latest release, and no hold is overdue.

A row marked BLOCKED is a release the upgrade cannot move to on its own: do the prerequisite it names (or, when it
is not doable from this worktree, file it as a task with \`add_task\` and say so), then upgrade again. A row marked
HELD is listed so a hold is never silent: leave it unless its reason no longer stands, in which case delete the
hold and let the upgrade move it. Every updater's holds share one shape — \`names\`, one \`version\` or everything
from \`below\` up, a \`reason\`, the upstream \`issue\` URL, and a \`reviewBy\` date at most 90 days out. A hold
blocks its releases until it is deleted; \`reviewBy\` only says when it must be looked at again.

If you cannot reach a clear verdict (verdict \`aborted\`: the command itself failed, its \`error\` says why; a
regression you cannot attribute; a flaky gate that never settles), do NOT push: raise a flag describing what you
saw.`;
