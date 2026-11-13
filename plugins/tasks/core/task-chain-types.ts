import { z } from "zod";

export const TaskChainTargetSchema = z.discriminatedUnion("kind", [
  // Root task stamped with a category (system filing paths, e.g. Improve).
  z.object({ kind: z.literal("category"), categoryId: z.string().min(1) }),
  z.object({ kind: z.literal("folder"), folderTaskId: z.string().min(1) }),
  // Top-level task — no folder, no category.
  z.object({ kind: z.literal("root") }),
]);
export type TaskChainTarget = z.infer<typeof TaskChainTargetSchema>;

export const TaskChainRelateModeSchema = z.enum(["prerequisite", "followup"]);
export type TaskChainRelateMode = z.infer<typeof TaskChainRelateModeSchema>;

export const TaskChainRelateSchema = z.object({
  taskId: z.string().min(1),
  mode: TaskChainRelateModeSchema,
  insertBefore: z.array(z.string().min(1)).optional(),
  standalone: z.boolean().optional(),
});
export type TaskChainRelate = z.infer<typeof TaskChainRelateSchema>;

export const TaskChainCardSchema = z.object({
  text: z.string().min(1),
  // Contributed launch-option values, keyed by option id — the registry in
  // `tasks/launch-options` owns what an id means and how its value is applied,
  // so this contract does not name a single option. Each value is validated by
  // the registered option's own schema; an unknown id is a 400.
  options: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
  // When false, this card does not block on the previous card (parallel launch).
  // Omitted means true (sequential, default). Ignored on the head card.
  linkedToPrev: z.boolean().optional(),
});
export type TaskChainCard = z.infer<typeof TaskChainCardSchema>;

export const TaskChainSubmitBodySchema = z.object({
  target: TaskChainTargetSchema,
  // The plugin id of the surface filing the chain (`TaskFiling.filedFrom`).
  // The author is never sent: a drafted task is a person's, stamped by the
  // server.
  filedFrom: z.string().min(1),
  // Only the head card honors `relate`.
  relate: TaskChainRelateSchema.optional(),
  cards: z.array(TaskChainCardSchema).min(1),
});
export type TaskChainSubmitBody = z.infer<typeof TaskChainSubmitBodySchema>;

export const TaskChainSubmitResponseSchema = z.object({
  taskIds: z.array(z.string()),
});
export type TaskChainSubmitResponse = z.infer<typeof TaskChainSubmitResponseSchema>;
