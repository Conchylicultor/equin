import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const articleIcon = symbol("article");

/** Not prompt text: the marker separating the static system prompt from the
 *  part assembled per session. It sits at index 1 in every payload seen. */
const DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

interface PromptSnapshotTool {
  name?: string;
  /** Present, and enormous — never rendered. */
  description?: string;
  schema?: unknown;
}

interface PromptSnapshotPayload {
  type: "prompt_snapshot";
  systemPrompt?: string[];
  /** Absent from half the payloads. */
  tools?: PromptSnapshotTool[];
}

/** The muted rule standing where the boundary marker was, naming what changes
 *  below it. A bare rule would leave the reader guessing why the prompt breaks
 *  in two. */
function DynamicBoundary() {
  return (
    <Stack direction="row" align="center" gap="sm">
      <Text variant="caption" tone="muted">
        Dynamic
      </Text>
      <Fill>
        <div className="border-t border-border/50" />
      </Fill>
    </Stack>
  );
}

/**
 * The exact prompt an agent was handed — the thing you read when you are trying
 * to work out why it behaved the way it did, and far too large to sit open in
 * the transcript.
 *
 * So the collapsed line has to be worth trusting on its own: `System prompt
 * · 14 sections · 14 tools` says how much prompt there was and whether the
 * agent had tools at all, which is what decides whether the reader opens it.
 * Always collapsed.
 *
 * Tools appear by NAME only. Their descriptions are the bulk of the payload
 * (each is a full tool spec), and a reader scanning a prompt wants to know
 * which tools were on the table, not to re-read their manuals.
 */
export function PromptSnapshotView({ event }: AttachmentRendererProps) {
  const att = event.attachment as PromptSnapshotPayload;
  if (!Array.isArray(att.systemPrompt)) {
    throw new Error("prompt_snapshot attachment carries no `systemPrompt`");
  }

  const segments = att.systemPrompt;
  // The marker is structure, not content, so it is not one of the sections we
  // count or render.
  const sectionCount = segments.filter((s) => s !== DYNAMIC_BOUNDARY).length;
  const toolNames = (att.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");

  const note = [
    `${sectionCount} ${sectionCount === 1 ? "section" : "sections"}`,
    toolNames.length > 0
      ? `${toolNames.length} ${toolNames.length === 1 ? "tool" : "tools"}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <CollapsibleCard
      icon={<Icon icon={articleIcon} className="size-3.5" />}
      label="System prompt"
      note={`· ${note}`}
    >
      <Scroll className="max-h-96">
        <Stack gap="sm">
          {segments.map((segment, i) =>
            // Keyed by position: the segments are prompt prose with no id of
            // their own, and two identical ones would still be two sections.
            segment === DYNAMIC_BOUNDARY ? (
              <DynamicBoundary key={`boundary-${i}`} />
            ) : (
              <Text
                as="pre"
                variant="caption"
                tone="muted"
                key={`segment-${i}`}
                className="whitespace-pre-wrap break-words"
              >
                {segment}
              </Text>
            ),
          )}
          {toolNames.length > 0 && (
            <Cluster gap="xs">
              {toolNames.map((name) => (
                <Text variant="code" tone="muted" key={name}>
                  {name}
                </Text>
              ))}
            </Cluster>
          )}
        </Stack>
      </Scroll>
    </CollapsibleCard>
  );
}
