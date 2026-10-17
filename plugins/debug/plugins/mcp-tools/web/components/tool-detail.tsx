import type { ReactElement, ReactNode } from "react";
import {
  ResourceErrorInline,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { SectionCard } from "@plugins/primitives/plugins/section-card/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { PluginLink } from "@plugins/plugin-meta/plugins/plugin-view/web";
import {
  agentToolName,
  mcpCatalog,
  type McpCatalogTool,
} from "@plugins/infra/plugins/mcp/core";
import {
  VISIBILITY_LABEL,
  toolParams,
  toolVisibility,
  type ToolParam,
} from "../internal/present";
import { ToolBadges, pluginPath } from "./tools-view";

/** One tool of the live catalog: loading, failed, absent, or the tool. */
export function useCatalogTool(
  name: string,
): ResourceResult<McpCatalogTool | null> {
  return mapResource(
    useLive(mcpCatalog),
    (catalog) => catalog.tools.find((t) => t.name === name) ?? null,
  );
}

/** The detail of one tool, read from the (already loaded) catalog. */
export function ToolDetail({ name }: { name: string }): ReactElement {
  const result = useCatalogTool(name);
  switch (result.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the MCP tool catalog"
          error={result.error}
          refetch={result.refetch}
        />
      );
    case "ready":
      break;
  }
  if (result.data === null) {
    return (
      <Placeholder tone="error">
        No MCP tool named {name} is registered in this backend.
      </Placeholder>
    );
  }
  return <ToolDetailBody tool={result.data} />;
}

function ToolDetailBody({ tool }: { tool: McpCatalogTool }): ReactElement {
  const params = toolParams(tool);
  const schema = JSON.stringify(tool.inputSchema, null, 2);
  return (
    <Stack gap="xl" className="rail-lg">
      <Stack gap="xs">
        <Text as="h2" variant="heading">
          <Text variant="code">{tool.name}</Text>
        </Text>
        <Stack direction="row" gap="xs" align="center">
          <ToolBadges tool={tool} />
        </Stack>
      </Stack>

      <Stack gap="sm">
        <Fact label="Declared in">
          {tool.declaredIn === null ? (
            pluginPath(null)
          ) : (
            <PluginLink
              name={tool.declaredIn}
              label={pluginPath(tool.declaredIn)}
            />
          )}
        </Fact>
        <Fact label="Agents call it">
          <Text variant="code">{agentToolName(tool.name)}</Text>{" "}
          <CopyButton aspect="inline" text={agentToolName(tool.name)} />
        </Fact>
        <Fact label="Visible to">
          <VisibleTo tool={tool} />
        </Fact>
      </Stack>

      <SectionCard
        title="Description"
        defaultOpen
        actions={<CopyButton text={tool.description} tooltip="Copy" />}
      >
        <Stack gap="sm">
          <Markdown>{tool.description}</Markdown>
          {tool.hasLiveDescription ? (
            <Text variant="caption" tone="muted">
              + a live section, rendered per conversation when its client lists
              the tools and appended after a blank line.
            </Text>
          ) : null}
        </Stack>
      </SectionCard>

      <SectionCard title={`Arguments (${params.length})`} defaultOpen>
        {params.length === 0 ? (
          <Text variant="caption" tone="muted">
            Takes no arguments.
          </Text>
        ) : (
          <Stack gap="md">
            {params.map((p) => (
              <Param key={p.name} param={p} />
            ))}
          </Stack>
        )}
      </SectionCard>

      <SectionCard
        title="Input schema (as tools/list sends it)"
        actions={<CopyButton text={schema} tooltip="Copy" />}
      >
        <HighlightedCode code={schema} lang="json" />
      </SectionCard>
    </Stack>
  );
}

function VisibleTo({ tool }: { tool: McpCatalogTool }): ReactElement {
  switch (toolVisibility(tool)) {
    case "profile":
      return (
        <>
          Only scratch conversations whose profile lists it (
          {tool.profiles?.join(", ")}) — never the default scope.
          {tool.gated ? " Its own gate applies on top." : ""}
        </>
      );
    case "gated":
      return (
        <>
          {VISIBILITY_LABEL.gated}: listed only for conversations its{" "}
          <Text variant="code">when</Text> accepts.
        </>
      );
    case "everywhere":
      return <>{VISIBILITY_LABEL.everywhere} in the default scope.</>;
  }
}

function Param({ param }: { param: ToolParam }): ReactElement {
  return (
    <Stack gap="none">
      <Stack direction="row" gap="sm" align="center">
        <Text variant="code" tone="strong">
          {param.name}
        </Text>
        <Text variant="code" tone="muted">
          {param.type}
        </Text>
        {param.required ? <Badge variant="destructive">required</Badge> : null}
      </Stack>
      {param.description !== null ? (
        <Text variant="caption" tone="muted" className="whitespace-pre-wrap">
          {param.description}
        </Text>
      ) : null}
    </Stack>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Stack direction="row" gap="md" align="start">
      <Text variant="caption" tone="muted" className={`w-28 ${rigidClass()}`}>
        {label}
      </Text>
      <Text variant="caption">{children}</Text>
    </Stack>
  );
}
