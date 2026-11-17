import {
  LEGACY_IDS,
  PRODUCT_NAME,
} from "@plugins/framework/plugins/product-name/core";
import { WORKTREES_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import { releaseVersion } from "@plugins/upstream/plugins/release/core";

/** What the instructions need to name. A structural shape, so this module is a
 * pure function of plain data — no zod, no git, no database. */
export interface UpstreamUpdates {
  /** Upstream's newest release tag, the one merged (`v2026.11.14`). */
  latest: string;
  /** The newest release local `main` holds, if any. */
  current: string | null;
  /** The upstream repository's URL. */
  url: string;
}

/** The task title, whoever files it. */
export function upstreamMergeTitle(d: UpstreamUpdates): string {
  return `[upstream] Update to ${PRODUCT_NAME} ${releaseVersion(d.latest)}`;
}

/**
 * The template's variables for one release — what the Upstream merges
 * automation fills its (editable) prompt with.
 */
export function upstreamMergeVariables(d: UpstreamUpdates): {
  updates: string;
  ref: string;
} {
  const from =
    d.current === null
      ? "This checkout holds no release yet."
      : `This checkout is on ${releaseVersion(d.current)}.`;
  return {
    updates: `Upstream (${d.url}) has released ${PRODUCT_NAME} ${releaseVersion(d.latest)}. ${from}`,
    ref: d.latest,
  };
}

/**
 * The standing instructions of an upstream-merge task, as a template:
 * `{{updates}}` (the release and where this checkout stands), `{{ref}}` (the
 * release tag merged) and `{{pushPolicy}}` (what the agent may do with the
 * merged branch). The Upstream merges automation commits it as its config's
 * default `prompt`.
 *
 * Fixed text, and deliberately short on judgement calls: the mechanical half is
 * one command (`./equin upstream merge`), so the agent never re-derives
 * the fetch/merge/refspec dance from prose. What is left is the part only a
 * person present can decide — a conflicted migration — and whether it lands,
 * which the push policy says.
 */
export const UPSTREAM_MERGE_PROMPT = `{{updates}}

Bring it into THIS worktree. You own proving the merged tree works.

1. Run \`./equin upstream merge\` in this worktree. It fetches upstream and merges its
   newest release, the tag \`{{ref}}\`, into the branch you are on.
   This is the one sanctioned merge in this repo: rebasing the user's own trunk onto
   upstream would replay their entire history on every update and rewrite \`main\` under
   every open worktree.

2. Resolve whatever conflicts it leaves in the tree.
   - **Generated files re-derive themselves.** The \`.gitattributes\` merge drivers take the
     upstream side, and \`./equin push\` re-runs the generators over the merged tree.
     Do not hand-resolve a generated artifact.
   - **A conflicted migration is the one thing to stop on.** Two sides altering the same
     table is a decision a person makes, not a merge you resolve. Report it and wait.
   Then \`git add\` what you resolved and run \`./equin upstream merge --continue\`, which
   concludes the merge for you.

3. Run \`./equin build\` in the background, then confirm the deploy receipt at
   \`${WORKTREES_DIR_DISPLAY}/<worktree>/build-status.json\` says \`"status": "ok"\`.

   **Migrations.** When both sides added schema migrations, the build writes one new
   migration itself: a *merge node* (\`…__merge_snapshot.sql\`, whose SQL is only a
   \`-- ${LEGACY_IDS.migrationMarker}:snapshot id=… parents=…,…\` header, plus the new \`meta/schema.snapshot.json\`) that joins the two
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
