import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

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
  parents: wholeList(z.string(), {
    reason: "one commit's parents — one, or two for a merge",
  }),
  trailers: wholeList(CommitTrailerSchema, {
    reason: "one commit message's trailers — a handful of lines",
  }),
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

/**
 * Every value of a commit's `key` trailer, in message order (a key may repeat:
 * one `Co-Authored-By` per co-author). Case-insensitive, like
 * {@link commitTrailer}.
 */
export function commitTrailerValues(commit: CommitRow, key: string): string[] {
  const wanted = key.toLowerCase();
  return commit.trailers
    .filter((t) => t.key.toLowerCase() === wanted)
    .map((t) => t.value);
}

/** Git's own co-author trailer (GitHub's spelling; matched case-insensitively). */
export const CO_AUTHORED_BY_TRAILER_KEY = "Co-Authored-By";

/** A person as git spells one: `Name <email>`. */
export interface GitIdent {
  name: string;
  /** Empty when the value carried no `<email>`. */
  email: string;
}

/** `Name <email>` → its parts; a value with no `<…>` is all name. */
export function parseGitIdent(value: string): GitIdent {
  const m = /^(.*?)\s*<([^<>]*)>\s*$/.exec(value.trim());
  if (!m) return { name: value.trim(), email: "" };
  return { name: m[1]!.trim() || m[2]!.trim(), email: m[2]!.trim() };
}

/** The commit's co-authors, from its {@link CO_AUTHORED_BY_TRAILER_KEY} trailers. */
export function commitCoAuthors(commit: CommitRow): GitIdent[] {
  return commitTrailerValues(commit, CO_AUTHORED_BY_TRAILER_KEY).map(
    parseGitIdent,
  );
}
