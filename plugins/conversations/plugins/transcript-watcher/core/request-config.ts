import { z } from "zod";

/**
 * The settings one model API call was made with, lifted from Claude Code's
 * `type: "api-request"` transcript line (one per call). Only what a reader of
 * the transcript can act on: the rest of the line — content hashes that rebuild
 * the exact request from `api-request-blob` / `api-request-shape` lines, cache
 * breakpoints, the permission classifier's full context — stays out.
 */
export const RequestConfigSchema = z.object({
  model: z.string(),
  effort: z.string().optional(),
  /** `params.thinking.type` — `adaptive`, `enabled`, `disabled`. */
  thinking: z.string().optional(),
  maxTokens: z.number().optional(),
  permissionMode: z.string().optional(),
  betas: z.array(z.string()),
  /** Hash of the call's system prompt + tool set: changes when either does. */
  shapeHash: z.string().optional(),
});
export type RequestConfig = z.infer<typeof RequestConfigSchema>;

const SCALAR_FIELDS = [
  "model",
  "effort",
  "thinking",
  "maxTokens",
  "permissionMode",
] as const;
export type RequestConfigScalarField = (typeof SCALAR_FIELDS)[number];

export type RequestConfigChange =
  | {
      field: RequestConfigScalarField;
      from: string | number | undefined;
      to: string | number | undefined;
    }
  | { field: "betas"; added: string[]; removed: string[] }
  | { field: "shape" };

/** What differs between two consecutive calls' settings, in display order. */
export function requestConfigChanges(
  previous: RequestConfig,
  next: RequestConfig,
): RequestConfigChange[] {
  const changes: RequestConfigChange[] = [];
  for (const field of SCALAR_FIELDS) {
    if (previous[field] !== next[field]) {
      changes.push({ field, from: previous[field], to: next[field] });
    }
  }
  const before = new Set(previous.betas);
  const after = new Set(next.betas);
  const added = next.betas.filter((b) => !before.has(b));
  const removed = previous.betas.filter((b) => !after.has(b));
  if (added.length > 0 || removed.length > 0) {
    changes.push({ field: "betas", added, removed });
  }
  if (previous.shapeHash !== next.shapeHash) changes.push({ field: "shape" });
  return changes;
}
