import { z } from "zod";

/**
 * What a model API call was sent besides the conversation, lifted from Claude
 * Code's `type: "api-request-shape"` transcript line: the system prompt and the
 * tool set. Claude Code writes the line once per distinct shape, the first
 * time a call uses it (an `api-request` line names its shape by `shapeHash`),
 * so a new one marks the moment the agent's tools or instructions changed —
 * typically a deferred tool loaded through ToolSearch. Only what a reader acts
 * on: each tool's name (not its description or input schema) and the system
 * prompt's text.
 */
export const RequestShapeSchema = z.object({
  /** Tool names, in the order the call listed them. */
  tools: z.array(z.string()),
  /** The system prompt's text blocks, in order. */
  system: z.array(z.string()),
});
export type RequestShape = z.infer<typeof RequestShapeSchema>;

export const RequestShapeChangeSchema = z.object({
  toolsAdded: z.array(z.string()),
  toolsRemoved: z.array(z.string()),
  systemChanged: z.boolean(),
});
/** What a shape changed relative to the one before it. */
export type RequestShapeChange = z.infer<typeof RequestShapeChangeSchema>;

/** The tools added and removed, and whether the system prompt's text changed. */
export function requestShapeChange(
  previous: RequestShape,
  next: RequestShape,
): RequestShapeChange {
  const before = new Set(previous.tools);
  const after = new Set(next.tools);
  return {
    toolsAdded: next.tools.filter((t) => !before.has(t)),
    toolsRemoved: previous.tools.filter((t) => !after.has(t)),
    systemChanged:
      previous.system.length !== next.system.length ||
      previous.system.some((text, i) => text !== next.system[i]),
  };
}
