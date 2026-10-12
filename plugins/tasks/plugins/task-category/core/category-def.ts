import { z } from "zod";

// One registered task category, as contributed by a filing plugin.
export const TaskCategoryDefSchema = z.object({
  id: z.string(),
  label: z.string(),
  order: z.number().optional(),
});
export type TaskCategoryDef = z.infer<typeof TaskCategoryDefSchema>;
