import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

export const GitTagsSchema = z.object({
  /** A digest of every `refs/tags/*` name and the object it points at. */
  digest: z.string(),
});

export type GitTags = z.infer<typeof GitTagsSchema>;

/**
 * The repo's tags, as a digest that moves whenever one is created, moved or
 * deleted (a `git tag` in a terminal included). Server-only in practice: its
 * readers are other values' `recomputeOn` (a release cut is a new tag).
 */
export const gitTags = liveValue("git-watcher.tags", {
  schema: GitTagsSchema,
});
