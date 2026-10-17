import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveFrom,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { ToolsView } from "./components/tools-view";
import { ToolDetail, useCatalogTool } from "./components/tool-detail";

const mcpToolsRoute = defineRoute({
  id: "debug-mcp-tools",
  segment: "mcp-tools",
});

export const mcpToolsPane = Pane.define({
  title: "MCP tools",
  route: mcpToolsRoute,
  app: debugApp,
  component: McpToolsBody,
  width: 600,
});

function McpToolsBody(): ReactElement {
  const openPane = useOpenPane();
  const open = mcpToolPane.useRouteEntry()?.params;
  return (
    <PaneChrome pane={mcpToolsPane}>
      <ToolsView
        selectedName={open?.name}
        linkTo={(t) =>
          openPane.to(mcpToolPane, { name: t.name }, { mode: "push" })
        }
      />
    </PaneChrome>
  );
}

function useResolveTool({ name }: { name: string }): ResolveResult {
  return resolveFrom(useCatalogTool(name), (tool) => tool !== null);
}

// Detail (/debug/mcp-tools/tool/<name>): one tool — where it is declared, who
// sees it, its full description, arguments and the schema agents receive.
export const mcpToolPane = Pane.define({
  title: "MCP tool",
  route: defineRoute({
    id: "debug-mcp-tool",
    segment: "tool/:name",
    parent: mcpToolsRoute,
  }),
  app: debugApp,
  useResolve: useResolveTool,
  component: McpToolBody,
  width: 560,
});

function McpToolBody(): ReactElement {
  const { name } = mcpToolPane.useParams();
  return (
    <PaneChrome pane={mcpToolPane}>
      <ToolDetail name={name} />
    </PaneChrome>
  );
}
