import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { CODE_MACHINE } from "@plugins/code-explorer/plugins/code-api/core";

const NotFoundSchema = z.object({ kind: z.literal("not-found") });
// The path names one existing file, and where its bytes live: `git` — inside
// the worktree, `path` relative to it (an absolute or `~` path inside the
// worktree comes back relativized); `host` — anywhere else, `path` absolute.
const ExactSchema = z.object({
  kind: z.literal("exact"),
  source: z.enum(["git", "host"]),
  path: z.string(),
});

/**
 * The most candidates a resolution names. A short query (`index.ts`) matches
 * thousands of a checkout's files; the disambiguation list a person picks from
 * is useful far below this, and `total` says how many matched.
 */
export const RESOLVE_MAX_MATCHES = 200;

export const ResolvedFileSchema = z.discriminatedUnion("kind", [
  NotFoundSchema,
  ExactSchema,
  z.object({
    kind: z.literal("resolved"),
    /**
     * The best {@link RESOLVE_MAX_MATCHES} candidates, checkout-relative:
     * suffix matches first, each group shortest first.
     */
    matches: z.array(z.string()),
    /** How many files matched; more than `matches` holds when capped. */
    total: z.number(),
  }),
]);
export type ResolvedFile = z.infer<typeof ResolvedFileSchema>;

/**
 * Where a requested path resolves in a workspace: an existing file named
 * exactly (`exact`, any workspace kind), else — in a git checkout — the
 * checkout's files whose path segments hold the query's as a subsequence
 * (`resolved`, BOUNDED: at most {@link RESOLVE_MAX_MATCHES}, with the
 * `total`), else `not-found` (a scratch workspace has no file list to match
 * against). On demand: invalidated while read from a watch of the entry the
 * path names and, in a checkout, the checkout watch (a file created or
 * removed, the index, a `.gitignore` edit). Refused: `no-workspace`.
 */
export const resolvedFile = liveValue("code.resolve-file", {
  schema: ResolvedFileSchema,
  params: ["worktree", "path"],
  load: "on-demand",
  refusals: ["no-workspace"],
  needsMachine: CODE_MACHINE,
});
