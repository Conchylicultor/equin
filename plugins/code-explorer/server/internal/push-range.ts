import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { pushes } from "@plugins/tasks/plugins/tasks-core/server";
import { tryRunGit } from "@plugins/primitives/plugins/commit-list/server";

/**
 * What resolving a push's range reads in Postgres: the push's `pushes` rows.
 * A live value whose loader resolves one declares it as its `reads`.
 */
export const pushRangeReads = {
  tables: [pushes],
  reason:
    "a push's range is the commits of its pushes rows; a row of the push landing (the ledger re-deriving main) moves which commits it spans — whole-table until the read is a collection lookup",
};

/**
 * The range one push landed, or why there is none — each a determinate
 * answer the caller turns into its own refusal:
 *
 * - `ok` — `baseSha..headSha`: `headSha` the push's tip, the one commit of the
 *   push no other of its commits reaches; `baseSha` the first parent of the
 *   push's earliest commit, the one every other descends from. Ordered by
 *   ancestry, never by commit time (commits rebased together share their
 *   second).
 * - `no-push` — no row carries `pushId`;
 * - `missing` — a commit of the push is not in `root`'s object store;
 * - `no-base` — the push's earliest commit is a root commit.
 */
export type PushRange =
  | { kind: "ok"; baseSha: string; headSha: string }
  | { kind: "no-push" }
  | { kind: "missing" }
  | { kind: "no-base"; first: string };

/**
 * The range the push `pushId` landed, from its ledger rows (all of them — the
 * read is the push's own rows, not a window) and git ancestry in the object
 * store at `root`. Reads {@link pushRangeReads}.
 *
 * Read straight from the table, not through tasks-core's `ensureFresh` gate:
 * the push id comes from the `pushes` collection the reader holds, which is
 * this same table, and a row of the push landing later recomputes the value
 * through its declared reads.
 */
export async function resolvePushRange(
  root: string,
  pushId: string,
): Promise<PushRange> {
  const rows = await db
    .select({ sha: pushes.sha })
    .from(pushes)
    .where(eq(pushes.pushId, pushId));
  if (rows.length === 0) return { kind: "no-push" };
  return pushRangeOf(root, pushId, [...new Set(rows.map((r) => r.sha))]);
}

/**
 * The range the commits `shas` of the push `pushId` span (see
 * {@link PushRange}), by their ancestry in the object store at `root`.
 */
export async function pushRangeOf(
  root: string,
  pushId: string,
  shas: string[],
): Promise<Exclude<PushRange, { kind: "no-push" }>> {
  // Each commit with its parents, full shas: `<sha> <parent>…` per line.
  const listed = await tryRunGit(
    ["rev-list", "--no-walk", "--parents", ...shas, "--"],
    root,
  );
  if (!listed.ok) return { kind: "missing" };
  const parents = new Map<string, string[]>();
  for (const line of listed.stdout.split("\n")) {
    const [sha, ...ps] = line.trim().split(" ");
    if (sha) parents.set(sha, ps);
  }
  if (parents.size !== shas.length) {
    throw new Error(
      `push ${pushId}: git listed ${parents.size} commits for ${shas.length} rows`,
    );
  }

  // The tip: the one commit no other reaches (a gap in the rows — a commit
  // of the branch the ledger holds no row for — is still one chain).
  const tips = await tryRunGit(["merge-base", "--independent", ...shas], root);
  if (!tips.ok)
    throw new Error(`git merge-base --independent failed: ${tips.stderr}`);
  const heads = tips.stdout.split("\n").filter((l) => l.trim() !== "");
  if (heads.length !== 1) {
    // A push lands one branch tip: its commits are that tip's ancestors.
    throw new Error(
      `push ${pushId}: its commits have ${heads.length} tips (${heads.join(", ")}), not one`,
    );
  }
  const headSha = heads[0]!.trim();
  // The earliest: the commit of the push every other one descends from.
  const oldest = await tryRunGit(["merge-base", "--octopus", ...shas], root);
  const first = oldest.ok ? oldest.stdout.trim() : "";
  if (!parents.has(first)) {
    throw new Error(
      `push ${pushId}: no commit of it is an ancestor of all the others`,
    );
  }
  const baseSha = parents.get(first)![0];
  if (baseSha === undefined) return { kind: "no-base", first };
  return { kind: "ok", baseSha, headSha };
}
