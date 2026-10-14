import type { McpScope, McpTool } from "./mcp";

/**
 * The tools a scope allows, before any tool's own `when`. Pure. A profile
 * naming a tool that does not exist, or one reserved for other profiles,
 * throws: a misconfigured allowlist is a bug to see, never a quietly smaller
 * tool list.
 */
export function toolsInScope(
  tools: ReadonlyMap<string, McpTool>,
  scope: McpScope,
): McpTool[] {
  if (scope.kind === "default") {
    return [...tools.values()].filter((t) => t.profiles === undefined);
  }
  return scope.tools.map((name) => {
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(
        `MCP scope "${scope.profile}" names tool "${name}", which is not registered`,
      );
    }
    if (tool.profiles && !tool.profiles.includes(scope.profile)) {
      throw new Error(
        `MCP scope "${scope.profile}" names tool "${name}", which is reserved for ${tool.profiles.join(", ")}`,
      );
    }
    return tool;
  });
}
