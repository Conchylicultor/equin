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
  /** The upstream repository's URL — `null` where the caller does not hold
   * it (the release status names the release, not the remote). */
  url: string | null;
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
    updates: `Upstream${d.url === null ? "" : ` (${d.url})`} has released ${PRODUCT_NAME} ${releaseVersion(d.latest)}. ${from}`,
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
 * The mechanical half is one command (`./equin upstream merge`), so the agent
 * never re-derives the fetch/merge/refspec dance from prose. The rest is the
 * agent's own work: it resolves every conflict itself — the user's intent and
 * the release's behaviour both kept, a schema decided in its `schema.ts`, never
 * in a migration file — and asks the user (its conversation then waits on
 * them) only for a product decision it cannot infer, or for the one migration
 * case no code edit can resolve. Whether the result lands is the push policy's
 * call; the user lands it from the conversation.
 */
export const UPSTREAM_MERGE_PROMPT = `{{updates}}

Bring it into THIS worktree. You own resolving the merge and proving the merged tree works.

1. Run \`./equin upstream merge\` in this worktree. It fetches upstream and merges its
   newest release, the tag \`{{ref}}\`, into the branch you are on.
   This is the one sanctioned merge in this repo: rebasing the user's own trunk onto
   upstream would replay their entire history on every update and rewrite \`main\` under
   every open worktree.

2. Resolve every conflict it leaves in the tree yourself. On each side read what the change
   was for (\`git log --merge -p -- <path>\`), and resolve it so the result keeps BOTH: the
   user's intent (their customisations, their data, the behaviour they built) and the
   release's behaviour (its fixes and features). Prefer the release's structure and re-apply
   the user's change on top of it when the two reshape the same code.
   - **Generated files re-derive themselves.** The \`.gitattributes\` merge drivers take the
     upstream side, and \`./equin build\` / \`./equin push\` re-run the generators over the
     merged tree. Do not hand-resolve a generated artifact.
   - **A schema is decided in code.** When both sides changed a table, resolve the owning
     \`schema.ts\` to the shape that serves both, and let the build generate whatever
     migration that shape needs. Never edit, delete or rename a file under
     \`plugins/database/plugins/migrations/data\`: both sides' migrations are published —
     already applied somewhere — and immutable. Keep every migration either side added; a
     conflicted \`meta/\` file there is re-derived by the build, so take upstream's side of it
     (\`git checkout --theirs -- <path>\`) and rebuild.
   - **Ask the user only for a product decision you cannot infer** — the two sides want
     incompatible behaviour, and neither the code, the commits nor the user's own tasks say
     which they would choose. Ask one precise question: the conflict, the options, and the
     one you recommend. Then wait for the answer; this conversation stays open for it.
     Anything you can decide from the code, decide.
   Then \`git add\` what you resolved and run \`./equin upstream merge --continue\`, which
   concludes the merge for you.

3. Run \`./equin build\` in the background, then confirm the deploy receipt at
   \`${WORKTREES_DIR_DISPLAY}/<worktree>/build-status.json\` says \`"status": "ok"\`. Fix
   what the build or its checks report — a type error, a failing check — the same way: keep
   both sides' intent.

   **Migrations.** When both sides added schema migrations, the build writes one new
   migration itself: a *merge node* (\`…__merge_snapshot.sql\`, whose SQL is only a
   \`-- ${LEGACY_IDS.migrationMarker}:snapshot id=… parents=…,…\` header, plus the new \`meta/schema.snapshot.json\`) that joins the two
   snapshot chains. That file is expected — keep it. Then drizzle-kit diffs your resolved
   \`schema.ts\` against it and writes a migration for whatever your resolution changed.
   One case no code edit resolves: a **snapshot merge conflict** (the build lists schema
   paths like \`tables.public.<table>.columns.<column>.type\`), or \`migration-applies-clean\`
   failing — one side's published migration cannot run on this database. Ask the user: quote
   that output verbatim, say what each side meant, and recommend a shape.

4. Open \`http://<worktree>.localhost:9000\` and check the app still works: it comes up, the
   screens you can reach render, the features the user built still do what they did, and
   Debug → Reports holds nothing new.

5. Report what changed — what the release brought in, every conflict you resolved and how,
   and anything that looked off. Then:
   {{pushPolicy}}

Never abandon the merge to make the tree look clean, and never resolve a conflict by
dropping one side's work wholesale.`;
