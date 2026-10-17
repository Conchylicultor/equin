import type {
  JsonlEvent,
  RequestShapeChange,
} from "@plugins/conversations/plugins/transcript-watcher/core";
import { formatTokenCount } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const toolsIcon = symbol("build");

type RequestShapeEvent = Extract<JsonlEvent, { kind: "request-shape" }>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function headline(change: RequestShapeChange | null): string {
  if (change === null) return "Tools and system prompt";
  const tools = change.toolsAdded.length + change.toolsRemoved.length > 0;
  if (tools && change.systemChanged) return "Tools and system prompt changed";
  return tools ? "Tools changed" : "System prompt changed";
}

/** The header preview: every tool on the first row, only the delta after. */
function summaryText(e: RequestShapeEvent): string {
  if (e.change === null) return e.shape.tools.join(", ");
  return [
    ...e.change.toolsAdded.map((t) => `+${t}`),
    ...e.change.toolsRemoved.map((t) => `−${t}`),
    ...(e.change.systemChanged ? ["system prompt edited"] : []),
  ].join(" ");
}

/**
 * The tool set as a wrapped strip of name chips — a tool's name is an id the
 * reader would type, so monospace. On a change row the added tools are tinted
 * and the removed ones follow, struck through, so the delta reads in place
 * against the whole set.
 */
function ToolChips({
  tools,
  change,
}: {
  tools: string[];
  change: RequestShapeChange | null;
}) {
  const added = new Set(change?.toolsAdded);
  return (
    <Cluster gap="2xs">
      {tools.map((tool) =>
        added.has(tool) ? (
          <Badge key={tool} mono variant="success" tooltip="Added">
            {tool}
          </Badge>
        ) : (
          <Badge key={tool} mono>
            {tool}
          </Badge>
        ),
      )}
      {change?.toolsRemoved.map((tool) => (
        <Badge
          key={tool}
          mono
          tooltip="Removed"
          className="line-through opacity-60"
        >
          {tool}
        </Badge>
      ))}
    </Cluster>
  );
}

/** The system prompt, folded: thousands of characters the reader opens on purpose. */
function SystemPrompt({ blocks }: { blocks: string[] }) {
  const chars = blocks.reduce((n, b) => n + b.length, 0);
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-caption text-muted-foreground hover:text-foreground">
        <Stack as="span" direction="row" gap="xs" align="center">
          <CollapsibleChevron className="size-3" />
          System prompt
          <span className="tabular-nums">
            · {formatTokenCount(chars)} characters
          </span>
        </Stack>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-xs">
        <ContentScope>
          <Text
            as="div"
            variant="body"
            className="border-l border-border pl-md text-foreground/85"
          >
            <Markdown>{blocks.join("\n\n")}</Markdown>
          </Text>
        </ContentScope>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * What model calls were sent besides the conversation: the tool set and the
 * system prompt. Claude Code logs a shape once, the first time a call uses it,
 * so the first row introduces the agent's tools and every later row is a
 * change — usually a deferred tool loaded through ToolSearch. The prompt is
 * shown only where it is new (the first row, or one that edited it).
 */
export function RequestShapeRow({ event }: { event: JsonlEvent }) {
  const e = event as RequestShapeEvent;
  const showSystem = e.change === null || e.change.systemChanged;
  return (
    <CollapsibleCard
      icon={<Icon icon={toolsIcon} className="size-3.5" />}
      label={headline(e.change)}
      note={`· ${plural(e.shape.tools.length, "tool")}`}
      summary={summaryText(e)}
    >
      <Stack gap="sm">
        <ToolChips tools={e.shape.tools} change={e.change} />
        {showSystem && e.shape.system.length > 0 && (
          <SystemPrompt blocks={e.shape.system} />
        )}
      </Stack>
    </CollapsibleCard>
  );
}
