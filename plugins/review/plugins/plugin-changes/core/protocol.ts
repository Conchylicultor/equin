import { z } from "zod";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";

const FACETS_REASON =
  "one plugin's facet data — one entry per facet extractor, a few dozen";

export interface DiffList {
  added: string[];
  removed: string[];
}

export const PluginChangedFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  from: z.string().optional(),
});
export type PluginChangedFile = z.infer<typeof PluginChangedFileSchema>;

export const PluginChangeDiffSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  path: z.string(),
  status: z.enum(["added", "modified"]),
  fileCount: z.number(),
  additions: z.number(),
  deletions: z.number(),
  files: wholeList(PluginChangedFileSchema, {
    reason: "one plugin's changed files — at most the files of that one plugin",
  }),
  /** Raw facet data (`node.facets`) for this plugin in the worktree. The server
   *  is facet-blind: it ships the data and the client computes per-facet diffs by
   *  iterating the `PluginChanges.DiffRenderer` slot (see `usePluginFacetDiffs`). */
  currentFacets: wholeRecord(z.unknown(), { reason: FACETS_REASON }),
  /** Raw facet data for the same plugin on main (`{}` when newly added). */
  mainFacets: wholeRecord(z.unknown(), { reason: FACETS_REASON }),
});
export type PluginChangeDiff = z.infer<typeof PluginChangeDiffSchema>;

export const PluginChangesSchema = z.object({
  plugins: wholeList(PluginChangeDiffSchema, {
    reason:
      "the plugins one worktree or one push added or modified — at most the repo's plugin count",
  }),
});
export type PluginChangesResponse = z.infer<typeof PluginChangesSchema>;

export interface PluginReviewProps {
  conversationId: string;
  plugin: PluginChangeDiff;
}
