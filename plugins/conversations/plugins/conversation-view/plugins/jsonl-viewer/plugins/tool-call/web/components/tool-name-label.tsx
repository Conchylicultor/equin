import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
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

/** A tool's name as the title of its timeline row: the code face (size and
 *  weight are the row title's), an MCP server dimmed and at the regular
 *  weight. The colour is the row's (muted at rest, bright when open or
 *  hovered). */
export function ToolNameTitle({
  tool,
  error,
}: {
  tool: ToolName;
  error?: boolean;
}) {
  return (
    <span className={cn("font-mono", error && "text-destructive")}>
      {tool.server && (
        <span className="font-normal opacity-60">{tool.server}:</span>
      )}
      {tool.name}
    </span>
  );
}
