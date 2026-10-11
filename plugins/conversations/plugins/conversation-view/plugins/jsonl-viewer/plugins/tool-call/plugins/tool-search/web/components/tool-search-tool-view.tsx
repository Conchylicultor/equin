import type { ReactNode } from "react";
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolNameLabel,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { ToolName } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { plural, readToolSearch } from "../internal/tool-search";

const names = (tools: ToolName[]) => tools.map((t) => t.name).join(", ");

/** One deferred tool as a chip: `<server>:<tool>` like the tool-call badge,
 *  and the full id the model calls in the tooltip. */
function ToolChip({ tool, missing }: { tool: ToolName; missing?: boolean }) {
  return (
    <Badge
      mono
      variant={missing ? "warning" : "primary"}
      title={missing ? `${tool.id} — not found` : tool.id}
    >
      <ToolNameLabel tool={tool} />
    </Badge>
  );
}

function ToolGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Stack gap="xs">
      <Text as="p" variant="caption" className="text-muted-foreground">
        {title}
      </Text>
      <Cluster gap="xs">{children}</Cluster>
    </Stack>
  );
}

/**
 * ToolSearch loads deferred tool schemas so the model can call them. The one
 * thing a reader wants from the row is WHICH tools became available — so the
 * collapsed line names them, and a `select:` that asked for a tool which did
 * not come back says so, since the model's next call to it will fail.
 */
export function ToolSearchToolView({ event }: ToolRendererProps) {
  const search = readToolSearch(event);
  const errorText = event.result?.isError ? event.result.content : undefined;

  if (search.mode === "select") {
    const { requested, loaded, missing } = search;
    const summary = loaded
      ? loaded.length > 0
        ? `Loaded ${names(loaded)}`
        : `Nothing loaded`
      : `Loading ${names(requested)}`;
    return (
      <ToolCallCard
        event={event}
        summary={summary}
        note={missing.length > 0 ? `· ${missing.length} not found` : undefined}
      >
        {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets the content stack from the card header */}
        <Stack gap="sm" className="mt-2">
          {loaded && loaded.length > 0 && (
            <ToolGroup title="Loaded">
              {loaded.map((t) => (
                <ToolChip key={t.id} tool={t} />
              ))}
            </ToolGroup>
          )}
          {missing.length > 0 && (
            <ToolGroup title="Not found among the deferred tools">
              {missing.map((t) => (
                <ToolChip key={t.id} tool={t} missing />
              ))}
            </ToolGroup>
          )}
          {!loaded && (
            <ToolGroup title="Requested">
              {requested.map((t) => (
                <ToolChip key={t.id} tool={t} />
              ))}
            </ToolGroup>
          )}
          {errorText && (
            <Text as="p" variant="caption" className="text-destructive">
              {errorText}
            </Text>
          )}
        </Stack>
      </ToolCallCard>
    );
  }

  const { query, maxResults, matches } = search;
  return (
    <ToolCallCard
      event={event}
      summary={`“${query}”`}
      note={
        matches
          ? matches.length > 0
            ? `· ${plural(matches.length, "match", "matches")}`
            : "· no matches"
          : undefined
      }
    >
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets the content stack from the card header */}
      <Stack gap="sm" className="mt-2">
        <Text as="p" variant="caption" className="text-muted-foreground">
          Searched deferred tools for{" "}
          <span className="font-mono text-foreground">{query}</span>
          {maxResults !== undefined && ` · top ${maxResults}`}
        </Text>
        {matches && matches.length > 0 && (
          <ToolGroup title="Loaded">
            {matches.map((t) => (
              <ToolChip key={t.id} tool={t} />
            ))}
          </ToolGroup>
        )}
        {errorText && (
          <Text as="p" variant="caption" className="text-destructive">
            {errorText}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}
