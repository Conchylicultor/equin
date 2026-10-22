import { WORKTREES_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import { renderPrompt } from "@plugins/tasks/plugins/automations/core";

/** What the instructions need to name. A structural shape, so this module is a
 * pure function of plain data — no zod, no report row, no database. */
export interface UpstreamUpdates {
  /** The remote-tracking ref the commits were counted against, e.g. `origin/main`. */
  ref: string;
  /** The URL that ref points at. */
  url: string;
  /** How many commits upstream holds that local `main` does not. */
  count: number;
  /** The newest of them, newest first — possibly fewer than `count`. */
  newest: ReadonlyArray<{ sha: string; subject: string }>;
}

function commitLines(d: UpstreamUpdates): string {
  const lines = d.newest.map((c) => `- \`${c.sha.slice(0, 9)}\` ${c.subject}`);
  const shown = d.newest.length;
  if (shown < d.count) lines.push(`- … and ${d.count - shown} older`);
  return lines.join("\n");
}

/** The task title, whoever files it. */
export function upstreamMergeTitle(d: UpstreamUpdates): string {
  return `[upstream] ${d.count} new commit${d.count === 1 ? "" : "s"} on ${d.ref}`;
}

/**
 * The template's variables for one set of updates — what the Upstream merges
 * automation fills its (editable) prompt with, and what the report's
 * Investigate fills the default one with.
 */
export function upstreamMergeVariables(d: UpstreamUpdates): {
  updates: string;
  ref: string;
} {
  return {
    updates: `Upstream has ${d.count} commit${d.count === 1 ? "" : "s"} this checkout does not, on \`${d.ref}\` (${d.url}).

Newest first:

${commitLines(d)}`,
    ref: d.ref,
  };
}

/**
 * The standing instructions of an upstream-merge task, as a template:
 * `{{updates}}` (the gap and its newest commits), `{{ref}}` (the
 * remote-tracking ref merged) and `{{pushPolicy}}` (what the agent may do with
 * the merged branch). The Upstream merges automation commits it as its config's
 * default `prompt`; Investigate on the report fills it with
 * {@link INVESTIGATE_PUSH_TEXT}.
 *
 * Fixed text, and deliberately short on judgement calls: the mechanical half is
 * one command (`./singularity upstream merge`), so the agent never re-derives
 * the fetch/merge/refspec dance from prose. What is left is the part only a
 * person present can decide — a conflicted migration — and whether it lands,
 * which the push policy says.
 */
export const UPSTREAM_MERGE_PROMPT = `{{updates}}

Bring them into THIS worktree. You own proving the merged tree works.

1. Run \`./singularity upstream merge\` in this worktree. It fetches upstream and merges
   \`{{ref}}\` into the branch you are on.
   This is the one sanctioned merge in this repo: rebasing the user's own trunk onto
   upstream would replay their entire history on every update and rewrite \`main\` under
   every open worktree.

2. Resolve whatever conflicts it leaves in the tree.
   - **Generated files re-derive themselves.** The \`.gitattributes\` merge drivers take the
     upstream side, and \`./singularity push\` re-runs the generators over the merged tree.
     Do not hand-resolve a generated artifact.
   - **A conflicted migration is the one thing to stop on.** Two sides altering the same
     table is a decision a person makes, not a merge you resolve. Report it and wait.
   Then \`git add\` what you resolved and run \`./singularity upstream merge --continue\`, which
   concludes the merge for you.

3. Run \`./singularity build\` in the background, then confirm the deploy receipt at
   \`${WORKTREES_DIR_DISPLAY}/<worktree>/build-status.json\` says \`"status": "ok"\`.

   **Migrations.** When both sides added schema migrations, the build writes one new
   migration itself: a *merge node* (\`…__merge_snapshot.sql\`, whose SQL is only a
   \`-- singularity:snapshot id=… parents=…,…\` header, plus the new \`meta/schema.snapshot.json\`) that joins the two
   snapshot chains. That file is expected — keep it. If the build instead stops on a
   **snapshot merge conflict** (it lists schema paths like
   \`tables.public.<table>.columns.<column>.type\`) or \`migration-applies-clean\` fails, stop
   and report that output verbatim. Never delete, rename or edit a file under
   \`plugins/database/plugins/migrations/data\` — both sides' migrations are already applied
   somewhere and are immutable.

4. Open \`http://<worktree>.localhost:9000\` and check the app still works: it comes up, the
   screens you can reach render, and Debug → Reports holds nothing new.

5. Report what changed — what the merge brought in, what you had to resolve, and anything
   that looked off. Then:
   {{pushPolicy}}

If the merge cannot be completed (a conflict you cannot resolve, a build that will not come
up, a migration clash), do NOT push: leave the tree as it is, say so, and wait for
instructions. Do not abandon the merge to make the tree look clean.`;

/**
 * Step 5 of a task the user minted by pressing Investigate: they asked for the
 * merge, not for it to land — they land it themselves.
 */
export const INVESTIGATE_PUSH_TEXT =
  "**Wait. Do not push.** The user lands this.";

/** The default template filled for the report's Investigate button. */
export function upstreamMergeInstructions(d: UpstreamUpdates): string {
  const rendered = renderPrompt(UPSTREAM_MERGE_PROMPT, {
    ...upstreamMergeVariables(d),
    pushPolicy: INVESTIGATE_PUSH_TEXT,
  });
  if (!rendered.ok)
    throw new Error(
      `upstream merge prompt names unfilled variables: ${rendered.unknown.join(", ")}`,
    );
  return rendered.text;
}
