import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  foldResource,
  matchResource,
} from "@plugins/primitives/plugins/live-state/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  mcpCatalog,
  type McpCatalog,
  type McpCatalogTool,
} from "@plugins/infra/plugins/mcp/core";
import {
  VISIBILITY_LABEL,
  firstLine,
  toolParams,
  toolVisibility,
  type ToolVisibility,
} from "../internal/present";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MCP_TOOLS_VIEW = defineDataView("debug.mcp-tools");

const NO_TOOLS: McpCatalogTool[] = [];
const VISIBILITY_VARIANT = {
  everywhere: "muted",
  gated: "warning",
  profile: "info",
} as const satisfies Record<ToolVisibility, string>;

const VISIBILITIES: ToolVisibility[] = ["everywhere", "gated", "profile"];

/** A plugin id as its folder path, the spelling a reader greps for. */
export function pluginPath(declaredIn: string | null): string {
  return declaredIn === null
    ? "(outside the register phase)"
    : asPath(asPluginId(declaredIn));
}

/**
 * Debug → MCP tools: every tool this backend's MCP server hosts, one row per
 * registered `Mcp.tool`, with the plugin that declared it. The rows come from
 * the registry itself, so a tool cannot be callable without appearing here.
 */
export function ToolsView({
  selectedName,
  linkTo,
}: {
  selectedName: string | undefined;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (tool: McpCatalogTool) => LinkTarget;
}): ReactElement {
  const result = useLive(mcpCatalog);
  const tools = foldResource(result, {
    loading: () => NO_TOOLS,
    error: () => NO_TOOLS,
    ready: (d) => d.tools,
  });

  // The catalog is loaded whole (bounded by the registered set), so its
  // declaring plugins ARE the options.
  const pluginOptions = useMemo(
    () =>
      [...new Set(tools.map((t) => pluginPath(t.declaredIn)))]
        .sort()
        .map((p) => ({ value: p, label: p })),
    [tools],
  );

  const fields = useMemo<FieldDef<McpCatalogTool>[]>(
    () => [
      {
        id: "name",
        label: "Tool",
        type: "identifier",
        primary: true,
        value: (t) => t.name,
        sortable: true,
      },
      {
        id: "description",
        label: "Description",
        type: "multiline-text",
        value: (t) => firstLine(t.description),
        sortable: false,
        filterable: false,
      },
      {
        id: "plugin",
        label: "Declared in",
        type: "enum",
        value: (t) => pluginPath(t.declaredIn),
        options: pluginOptions,
        filterable: true,
        groupable: true,
        visible: false,
      },
      {
        id: "visibility",
        label: "Visible to",
        type: "enum",
        value: toolVisibility,
        options: VISIBILITIES.map((value) => ({
          value,
          label: VISIBILITY_LABEL[value],
          variant: VISIBILITY_VARIANT[value],
        })),
        filterable: true,
        groupable: true,
      },
      {
        id: "live",
        label: "Live description",
        type: "enum",
        value: (t) => (t.hasLiveDescription ? "live" : "fixed"),
        options: [
          { value: "fixed", label: "Fixed" },
          { value: "live", label: "With a live section" },
        ],
        filterable: true,
        visible: false,
      },
      {
        id: "params",
        label: "Arguments",
        type: "number",
        value: (t) => toolParams(t).length,
        sortable: true,
      },
    ],
    [pluginOptions],
  );

  return (
    <Stack gap="sm">
      {/* The list below renders the read's loading and error states. */}
      {matchResource(result, {
        loading: () => null,
        error: () => null,
        ready: (catalog) => <Summary catalog={catalog} />,
      })}
      <DataView<McpCatalogTool>
        rows={tools}
        fields={fields}
        rowKey={(t) => t.name}
        views={["list"]}
        storageKey={MCP_TOOLS_VIEW}
        readiness={result}
        selectedRowId={selectedName}
        rowActivation={linkTo}
        searchAccessor={(t) =>
          `${t.name} ${pluginPath(t.declaredIn)} ${t.description}`
        }
        searchPlaceholder="Search tools, plugins, descriptions…"
        emptyState={<>Nothing matches.</>}
      />
    </Stack>
  );
}

/** The counts above the list, and the two contributions that are not tools. */
function Summary({ catalog }: { catalog: McpCatalog }): ReactElement {
  const plugins = new Set(catalog.tools.map((t) => t.declaredIn)).size;
  return (
    <Inset x="md" t="sm">
      <Stack gap="none">
        <Text variant="caption" tone="muted">
          {catalog.tools.length} tools from {plugins} plugins
          {" · "}
          {catalog.instructions.length} server instructions sections
          {catalog.instructions.length > 0
            ? ` (${catalog.instructions
                .map((i) => `${i.id} — ${pluginPath(i.declaredIn)}`)
                .join(", ")})`
            : ""}
        </Text>
        <Text variant="caption" tone="muted">
          {catalog.scope === null
            ? "No scope resolver: every conversation is in the default scope."
            : `Scope resolver: ${pluginPath(catalog.scope.declaredIn)}`}
        </Text>
      </Stack>
    </Inset>
  );
}

/** What sets a tool apart from an always-listed, fixed-text one. */
export function ToolBadges({ tool }: { tool: McpCatalogTool }): ReactElement {
  return (
    <>
      {tool.profiles?.map((p) => (
        <Badge key={p} variant="info" mono>
          {p}
        </Badge>
      ))}
      {tool.gated ? <Badge variant="warning">gated</Badge> : null}
      {tool.hasLiveDescription ? <Badge variant="success">live</Badge> : null}
    </>
  );
}
