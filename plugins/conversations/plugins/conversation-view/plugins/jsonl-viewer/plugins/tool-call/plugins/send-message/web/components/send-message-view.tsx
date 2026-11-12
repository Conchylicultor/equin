import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { useJsonlConversationId } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { useConversationSubagents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web";
import { agentReportPane } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/agent/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  readSendMessage,
  type Delivery,
  type Recipient,
  type SendMessageInput,
} from "../../core";

const articleIcon = symbol("article");

/** The sub-agent behind an agent id, as its launching `Agent` call named it. */
function useSubagentLabel(agentId: string | undefined) {
  const subagents = useConversationSubagents(useJsonlConversationId());
  if (agentId === undefined || subagents.kind !== "known") return undefined;
  const entry = subagents.entries.find((e) => e.row.agentId === agentId);
  if (entry?.row.kind !== "described") return undefined;
  // An unnamed sub-agent is known by what it was launched to do — the same
  // words its Agent card leads with — never by its hex id.
  return entry.row.name ?? entry.row.description;
}

function recipientText(
  recipient: Recipient,
  named: string | undefined,
): string {
  switch (recipient.kind) {
    case "main":
      return "main";
    case "agent-id":
      return named ?? recipient.short;
    case "name":
      return recipient.name;
  }
}

function deliveryNote(delivery: Delivery): string | undefined {
  switch (delivery.kind) {
    case "resumed":
      return "· resumed it";
    case "queued":
      return "· queued";
    case "failed":
      return "· not sent";
    case "pending":
    case "sent":
      return undefined;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function deliverySentence(delivery: Delivery, to: string): string | undefined {
  switch (delivery.kind) {
    case "resumed":
      return `${capitalize(to)} had stopped — this message started a new turn.`;
    case "queued":
      return `Queued — ${to} reads it at its next tool round.`;
    case "sent":
      return delivery.text;
    case "failed":
    case "pending":
      return undefined;
  }
}

export function SendMessageView({
  event,
  input,
}: ToolViewProps<SendMessageInput>) {
  const call = readSendMessage(input, event.result);
  const subagent = useSubagentLabel(call.agentId);
  const to = recipientText(call.recipient, subagent);
  const described =
    call.recipient.kind === "agent-id" && subagent !== undefined;
  const failed = call.delivery.kind === "failed";

  const openPane = useOpenPane();
  const open =
    call.agentId === undefined
      ? undefined
      : openPane.to(
          agentReportPane,
          { by: "agent", key: call.agentId },
          { mode: "push" },
        );

  const summary = (
    <Line as="span" className="gap-sm">
      <Badge
        colorClass="bg-categorical-6/15 text-categorical-6"
        // A described sub-agent reads by its launch words, which may run long:
        // it may shrink (the badge ellipsizes); a name or id stays whole.
        {...(described
          ? { className: "max-w-64", tooltip: to }
          : { mono: true, className: rigidClass() })}
      >
        → {to}
      </Badge>
      <Text className="text-muted-foreground">{call.headline}</Text>
    </Line>
  );

  // Who the sentences below speak of: the badge's own words, except where
  // they are launch words or a bare address.
  const subject = described
    ? "the sub-agent"
    : call.recipient.kind === "main"
      ? "the main conversation"
      : to;
  const sentence = deliverySentence(call.delivery, subject);

  return (
    <ToolCallCard
      event={event}
      summary={summary}
      note={deliveryNote(call.delivery)}
      aside={
        open && (
          <IconButton
            icon={articleIcon}
            label="Open sub-agent"
            {...activationProps(open, { isolate: true })}
          />
        )
      }
      defaultOpen={failed}
    >
      <Stack gap="sm">
        {call.body.kind === "text" && (
          <Scroll axis="both" className="max-h-96 px-md py-sm">
            <div className="prose-xs text-caption">
              <Markdown>{call.body.text}</Markdown>
            </div>
          </Scroll>
        )}
        {call.body.kind === "protocol" && (
          <Stack gap="2xs" className="px-md py-sm">
            <Text as="p" variant="caption" className="font-medium">
              {call.body.headline}
            </Text>
            {call.body.detail !== undefined && (
              <Text as="p" variant="caption" className="whitespace-pre-wrap">
                {call.body.detail}
              </Text>
            )}
          </Stack>
        )}
        {call.notifyWhenIdle && (
          <Text as="p" variant="caption" tone="muted" className="px-md">
            Asked to be told when {subject} next goes idle.
          </Text>
        )}
        {call.delivery.kind === "failed" && (
          <Text
            as="p"
            variant="caption"
            className="px-md text-destructive whitespace-pre-wrap"
          >
            {call.delivery.reason}
          </Text>
        )}
        {sentence !== undefined && (
          <Text as="p" variant="caption" tone="muted" className="px-md">
            {sentence}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}
