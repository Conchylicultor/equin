import type { ToolName } from "../../core";

/** A tool's name as a reader sees it: an MCP tool reads `<server>:<tool>` with
 *  its server dimmed, a built-in tool its own name. The one spelling every tool
 *  badge and chip draws, so they cannot disagree. */
export function ToolNameLabel({ tool }: { tool: ToolName }) {
  if (!tool.server) return tool.name;
  return (
    <>
      <span className="opacity-60">{tool.server}:</span>
      {tool.name}
    </>
  );
}
