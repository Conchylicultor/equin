import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

// Single source of truth for a worktree row — the scan's item, built by the
// server (server/internal/entries.ts) and listed by the web panel.
export const WorktreeEntrySchema = z.object({
  attemptId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  taskStatus: z.string(),
  attemptStatus: z.string(),
  worktreePath: z.string(),
  /** ISO instant (`Date#toISOString`, fixed precision) — the row's order key. */
  createdAt: z.string(),
  dirExists: z.boolean(),
  dbExists: z.boolean(),
  isDirty: z.boolean(),
  isSafe: z.boolean(),
});
export type WorktreeEntry = z.infer<typeof WorktreeEntrySchema>;

/** The question: the instant the scan was asked for (mount or Refresh). */
export const WorktreeScanQuerySchema = z.object({ at: z.number().int() });
export type WorktreeScanQuery = z.infer<typeof WorktreeScanQuerySchema>;

/** What the scan says about itself beside its rows — one per question. */
export const WorktreeScanMetaSchema = z.object({
  /** Rows the scan will build: every attempt, then every orphan dir found; `null` until the attempts are read. */
  planned: z.number().nullable(),
  /** Rows built so far. */
  scanned: z.number(),
  complete: z.boolean(),
  /** Rows safe to delete (`isSafe`) — what "Delete N safe" removes. */
  safe: z.number(),
});
export type WorktreeScanMeta = z.infer<typeof WorktreeScanMetaSchema>;

/**
 * Every worktree this host knows — one row per attempt (its checkout, fork DB,
 * git hygiene and whether the reaper would call it safe), then one per
 * canonical worktree dir no attempt row names (main only) — scanned once per
 * question and filled in as rows are built. A key-range-PAGED value, newest
 * first, since the list grows with every attempt ever made (thousands): read
 * through `useLivePagedValuePaging` under the panel's viewport, so only the
 * pages on screen are live. The scan's progress and safe count are the meta
 * sibling. A delete — the panel's, or the hourly sweep's — re-reads the rows
 * it touched in every held scan, so the list stays true after it.
 */
export const worktreeScan = liveValue("debug.worktree-cleanup.worktrees", {
  query: WorktreeScanQuerySchema,
  paged: {
    item: WorktreeEntrySchema,
    id: "attemptId",
    key: { of: (e) => [e.createdAt], order: ["desc"] },
    limit: 100,
    maxLimit: 500,
    meta: WorktreeScanMetaSchema,
  },
});
