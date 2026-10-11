import { z } from "zod";

/**
 * One `Key: value` trailer of a commit message (`Co-Authored-By`, a tool's own
 * provenance key …), in message order. Kept generic on purpose: this primitive
 * knows git, not what any one trailer key means — the plugin that owns a key
 * reads it off the row.
 */
export const CommitTrailerSchema = z.object({
  key: z.string(),
  value: z.string(),
});
export type CommitTrailer = z.infer<typeof CommitTrailerSchema>;

export const CommitRowSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string(),
  parents: z.array(z.string()),
  trailers: z.array(CommitTrailerSchema),
});
export type CommitRow = z.infer<typeof CommitRowSchema>;

/**
 * The value of a commit's `key` trailer, or `null` when the message carries
 * none. Git trailer keys are case-insensitive, so the match is too; with the
 * key repeated, the first occurrence wins.
 */
export function commitTrailer(commit: CommitRow, key: string): string | null {
  const wanted = key.toLowerCase();
  const hit = commit.trailers.find((t) => t.key.toLowerCase() === wanted);
  return hit === undefined ? null : hit.value;
}
