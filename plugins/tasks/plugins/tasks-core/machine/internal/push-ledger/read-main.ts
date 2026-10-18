/**
 * The git read behind the ledger. Deliberately DB-free, so `read-main.test.ts`
 * can exercise it against a throwaway repo with no database and no plugin
 * runtime — the same split `attempt-work` keeps between `measure.ts` and
 * `work.ts`.
 */
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import {
  TRAILER_LOG_FORMAT,
  parseTrailerLog,
  type TrailerCommit,
} from "../../../core";

/**
 * `main`'s trailer-bearing commits, newest first.
 *
 * `since` bounds the walk; `null` walks the whole history, which is only the
 * right answer for an empty ledger. Throws on any git failure — a failed read
 * must never resolve to "no commits landed", which is the exact absorbable
 * emptiness this design exists to remove.
 */
export async function readMainCommits(
  mainRepoRoot: string,
  since: Date | null,
): Promise<TrailerCommit[]> {
  const raw = await runGit(
    [
      "log",
      "--no-color",
      ...(since ? [`--since=${since.toISOString()}`] : []),
      `--format=${TRAILER_LOG_FORMAT}`,
      "refs/heads/main",
    ],
    mainRepoRoot,
  );
  return parseTrailerLog(raw);
}
