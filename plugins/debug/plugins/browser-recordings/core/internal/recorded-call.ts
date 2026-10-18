/**
 * Which tool calls drive a browser and so may have a recording: THE one
 * classification, read by the conversation view (which calls get a footer and
 * an artifact) and by the browser MCP tools (which calls capture a frame).
 */

/** The `browser_*` MCP tools whose call changes the page, so it is recorded. */
export const RECORDED_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_act",
  "browser_batch",
  "browser_javascript",
  "browser_viewport",
]);

/** A Bash command running a repo e2e script through the harness. */
const E2E_RUN_RE = /\bsingularity\s+run\s+\S*\/e2e\/\S+\.ts\b/;

/** `mcp__<server>__<tool>`, the name Claude Code gives an MCP tool call. */
const MCP_TOOL_RE = /^mcp__.+?__([a-z_]+)$/;

/** Does this tool call (its transcript name and input) record a browser? */
export function isRecordedToolCall(name: string, input: unknown): boolean {
  if (name === "Bash") {
    const command = (input as { command?: unknown } | null | undefined)
      ?.command;
    return typeof command === "string" && E2E_RUN_RE.test(command);
  }
  const tool = MCP_TOOL_RE.exec(name)?.[1];
  return tool !== undefined && RECORDED_BROWSER_TOOLS.has(tool);
}
