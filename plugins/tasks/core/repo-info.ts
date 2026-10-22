import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

export const RepoInfoSchema = z.object({
  /** `https://github.com/<owner>/<repo>` of the main checkout's `origin`, or `null` when it is not a GitHub remote (or there is none). */
  githubBase: z.string().nullable(),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

/**
 * The repository's GitHub base URL, read from the main checkout's `origin`
 * remote — what a push row links its sha to. A snapshot: re-read whenever a
 * reader asks (each mount), never pushed — the git config has no change signal
 * worth its cost (`machine/internal/repo-info.ts`). It reads a checkout, so
 * only the desktop app answers it: a reader on a host without one (the demo's
 * in-browser server) gets `unavailable` and shows its shas unlinked.
 */
export const repoInfo = liveValue("tasks.repo-info", {
  schema: RepoInfoSchema,
  load: "snapshot",
  needsMachine: { feature: "Reading the repository" },
});
