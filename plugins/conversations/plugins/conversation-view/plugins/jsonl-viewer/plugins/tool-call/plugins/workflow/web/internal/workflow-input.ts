import { z } from "zod";

/**
 * The Workflow tool's input, as its card draws it: the script inline, or the
 * path of a saved one, or a predefined workflow's name — each optional, the
 * tool takes one of them — and the args handed to the script as they are.
 */
export const WorkflowInputSchema = z.looseObject({
  script: z.string().optional(),
  scriptPath: z.string().optional(),
  name: z.string().optional(),
  args: z.unknown().optional(),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;
