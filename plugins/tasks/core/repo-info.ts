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
 * worth its cost (`server/internal/repo-info.ts`).
 */
export const repoInfo = liveValue("tasks.repo-info", {
  schema: RepoInfoSchema,
  load: "snapshot",
});
