import { z } from "zod";

/**
 * The name Claude Code gives the sub-agent launcher in a transcript's
 * `tool_use` block. The transcript renderer matches on it, and so does
 * anything that folds sub-agent launches out of the event stream.
 */
export const AGENT_TOOL_NAME = "Agent";

/**
 * A boolean tool parameter as it lands in a transcript. The transcript records
 * the model's call verbatim, and Claude Code accepts `"true"` / `"false"`
 * strings for a boolean parameter (it coerces them before running the tool) —
 * so both spellings are real launches and both must read as the boolean they
 * meant. Any other string still fails the parse.
 */
const toolBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);

/**
 * The `input` of an Agent tool call, as Claude Code writes it. Parsed (not
 * cast) wherever it is read, so a transcript whose shape drifted fails where
 * it is read rather than rendering `undefined`.
 */
export const AgentInputSchema = z.object({
  prompt: z.string(),
  description: z.string().optional(),
  subagent_type: z.string().optional(),
  model: z.string().optional(),
  isolation: z.string().optional(),
  run_in_background: toolBoolean.optional(),
  /** A named sub-agent's name — what its notifications and messages address it by. */
  name: z.string().optional(),
});
export type AgentInput = z.infer<typeof AgentInputSchema>;

/** The agent type a launch without `subagent_type` runs as. */
export const DEFAULT_AGENT_TYPE = "general-purpose";
