import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// Role of a single on-disk orphan file, derived from its path suffix and whether
// it lives under an `@app/<id>` scope segment.
export const orphanFileRoleSchema = z.enum([
  "origin", // <hier>/<name>.origin.jsonc — a stale git/code default snapshot
  "override", // <hier>/<name>.jsonc — a real base user override (has data)
  "ancestor", // <hier>/<name>.ancestor.jsonc — a transient three-way-merge base
  "scoped-origin", // <hier>/@app/<id>/<name>.origin.jsonc — a scoped default snapshot
  "scoped-override", // <hier>/@app/<id>/<name>.jsonc — a real scoped user override (has data)
]);
export type OrphanFileRole = z.infer<typeof orphanFileRoleSchema>;

// Risk of an orphaned descriptor group. `noise` = origin/ancestor snapshots only,
// zero user data (safe to drop). `stranded-data` = has a base or scoped OVERRIDE
// (.jsonc) — a real user customization that silently stopped applying.
export const orphanRiskClassSchema = z.enum(["noise", "stranded-data"]);
export type OrphanRiskClass = z.infer<typeof orphanRiskClassSchema>;

// Why the descriptor is gone. `relocated` = a live descriptor shares this name at
// a different hierarchy (the descriptor likely moved — an audit hint, not proof,
// since generic names like "config" can collide). `removed` = no live descriptor
// with this name at all.
export const orphanReasonSchema = z.enum(["relocated", "removed"]);
export type OrphanReason = z.infer<typeof orphanReasonSchema>;

export const orphanFileSchema = z.object({
  // Path relative to the config dir (forward-slash separated).
  relPath: z.string(),
  role: orphanFileRoleSchema,
  bytes: z.number(),
  mtimeMs: z.number(),
});
export type OrphanFile = z.infer<typeof orphanFileSchema>;

export const orphanEntrySchema = z.object({
  // "<hier>/<name>" — unique per orphaned descriptor group; the DataView row key.
  storeKey: z.string(),
  hier: z.string(),
  name: z.string(),
  riskClass: orphanRiskClassSchema,
  reason: orphanReasonSchema,
  // Present only when reason === "relocated": the hierarchy a live descriptor of
  // the same name now lives at (where the config likely moved to).
  relocatedToHier: z.string().optional(),
  files: wholeList(orphanFileSchema, {
    reason:
      "one orphaned descriptor group's files — its origin, override and ancestor snapshots, base and per-app: a handful",
  }),
  totalBytes: z.number(),
  newestMtimeMs: z.number(),
});
export type OrphanEntry = z.infer<typeof orphanEntrySchema>;

// Wrapped in an object for forward-compatible extensibility (future summary
// counts, scan metadata, …) without breaking the endpoint's response shape.
export const orphanReportSchema = z.object({
  orphans: wholeList(orphanEntrySchema, {
    reason:
      "the config files whose descriptor is no longer live — left by renamed or removed plugins, a few at most",
  }),
});
export type OrphanReport = z.infer<typeof orphanReportSchema>;
