/** A tool's name split for display: MCP tools read as their own name, with
 *  the server that provides them kept aside. */
export interface ToolName {
  /** The full name the model calls it by (`mcp__equin__add_task`). */
  id: string;
  /** What a reader recognises (`add_task`). */
  name: string;
  /** The MCP server providing it (`equin`), absent for built-in tools. */
  server?: string;
}

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

export function toolName(id: string): ToolName {
  const m = MCP_NAME.exec(id);
  return m ? { id, name: m[2]!, server: m[1]! } : { id, name: id };
}
