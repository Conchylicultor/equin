import { z } from "zod";
import { resolvableSchema, type Resolvable } from "@plugins/primitives/plugins/live-state/core";

export const EditedFileStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "untracked",
  "renamed",
  "copied",
  "clean",
]);
export type EditedFileStatus = z.infer<typeof EditedFileStatusSchema>;

export const EditedFileSchema = z.object({
  path: z.string(),
  status: EditedFileStatusSchema,
  additions: z.number().int(),
  deletions: z.number().int(),
  from: z.string().optional(),
});
export type EditedFile = z.infer<typeof EditedFileSchema>;

/**
 * The whole edited-file set's totals — `editedFiles.meta`. A `Resolvable`: a
 * conversation whose worktree we cannot resolve (never had one, or it was
 * reaped) has an UNKNOWN file set, not an empty one. The loader returns
 * `unresolved(reason)` for that determinate non-value instead of lying with a
 * zero count — which would render a legitimate "no changes" and arm the
 * destructive "Drop & Close". See resolvable.ts and
 * research/2026-07-09-global-resource-unknown-value-and-error-gate.md.
 */
export const EditedFilesSummarySchema = z.object({
  /** How many files the set holds (the pages hold them, by path). */
  count: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type EditedFilesSummary = z.infer<typeof EditedFilesSummarySchema>;
export const EditedFilesMetaSchema = resolvableSchema(EditedFilesSummarySchema);
export type EditedFilesMeta = Resolvable<EditedFilesSummary>;

export const EditedFilesQuerySchema = z.object({ id: z.string() });
export type EditedFilesQuery = z.infer<typeof EditedFilesQuerySchema>;
