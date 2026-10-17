import { isActionable, type Outdated } from "./updater";

/** One updater's share of an upgrade task: what it found outdated. */
export interface OutdatedUpdater {
  updaterId: string;
  outdated: readonly Outdated[];
  /** Repo-relative file where a hold for this updater is added. */
  holdsFile: string;
}

/** The title of the batched upgrade task: its actionable rows only. */
export function upgradeTaskTitle(batch: readonly OutdatedUpdater[]): string {
  return `Upgrade ${batch
    .filter((u) => u.outdated.some(isActionable))
    .map(
      (u) =>
        `${u.updaterId}: ${u.outdated
          .filter(isActionable)
          .map((o) => `${o.name} ${o.current ?? "(new)"} → ${o.latest}`)
          .join(", ")}`,
    )
    .join("; ")}`;
}

function formatOutdated(o: Outdated): string {
  const move = `${o.name} ${o.current ?? "(new)"} → ${o.latest}`;
  switch (o.waiting?.kind) {
    case undefined:
      return move;
    case "held":
      return `${move} — HELD until ${o.waiting.until}: ${o.waiting.reason}`;
    case "blocked":
      return `${move} — BLOCKED, do this first: ${o.waiting.prerequisite}`;
  }
}

/**
 * The `{{outdated}}` variable of the upgrade prompt: each outdated updater, the
 * file its holds live in, and every release move it found.
 */
export function outdatedSections(batch: readonly OutdatedUpdater[]): string {
  return batch
    .map(
      (u) =>
        `\`${u.updaterId}\` (holds in \`${u.holdsFile}\`):\n${u.outdated.map((o) => `- ${formatOutdated(o)}`).join("\n")}`,
    )
    .join("\n\n");
}

/**
 * The default prompt template of the batched upgrade task — what the build
 * commits as the Dependency upgrades config's `prompt`. Fixed steps: the agent
 * never improvises the gate, it runs the one command that implements it.
 * `{{pushPolicy}}` is what the automation's Push setting allows, scoped by
 * step 2 to an `upgraded` or `partial` verdict and an `ok` build.
 */
export const DEPS_UPGRADE_PROMPT = `Newer releases are available (seen on main by the Dependency upgrades automation):

{{outdated}}

Move this worktree to them, all in this one task. You own proving it works.

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
     file (listed above) with the reason, the issue URL and an \`until\` date at most 90 days out.
   - If it breaks only without another release it depends on, declare the two as one lockstep group.
   Then run \`./singularity deps upgrade\` again, and go back to step 2 on its verdict.

4. Verdict \`current\`: nothing to do. Everything is already on its latest release.

A row marked BLOCKED is a release the upgrade cannot move to on its own: do the prerequisite it names (or, when it
is not doable from this worktree, file it as a task with \`add_task\` and say so), then upgrade again. A row marked
HELD is listed so a hold is never silent: leave it unless its reason no longer stands, in which case delete the
hold and let the upgrade move it. Every updater's holds share one shape — \`names\`, one
\`version\` or everything from \`below\` up, a \`reason\`, the upstream \`issue\` URL, and an \`until\` date at most 90
days out — and the day after \`until\` the updater stops honouring it (renew it only if its reason still stands).

If you cannot reach a clear verdict (verdict \`aborted\`: the command itself failed, its \`error\` says why; a
regression you cannot attribute; a flaky gate that never settles), do NOT push: raise a flag describing what you
saw.`;
