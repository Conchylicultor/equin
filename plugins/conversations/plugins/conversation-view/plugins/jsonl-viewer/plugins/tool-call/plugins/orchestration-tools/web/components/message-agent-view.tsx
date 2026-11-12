import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  DELIVERIES,
  readMessageAnswer,
} from "@plugins/tasks/plugins/orchestration/plugins/message/core";
import { AgentChip, Refusal } from "./target-chip";

/** `message_agent`'s input, as its card draws it. */
export const MessageAgentInputSchema = z.object({
  to: z.string(),
  text: z.string(),
  reopen: z.boolean().optional(),
});
type MessageAgentInput = z.infer<typeof MessageAgentInputSchema>;

/** The message's first non-empty line — what the closed row previews. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function MessageAgentView({
  event,
  input,
}: ToolViewProps<MessageAgentInput>) {
  const answer = event.result ? readMessageAnswer(event.result.content) : null;
  const notSent = answer?.kind === "not-sent";

  return (
    <ToolCallCard
      event={event}
      aside={<AgentChip to={input.to.trim()} />}
      summary={firstLine(input.text)}
      note={notSent ? "· not sent" : input.reopen ? "· reopened" : undefined}
      isError={notSent || undefined}
      defaultOpen={notSent}
    >
      <Stack gap="sm">
        <div className="prose-xs text-caption">
          <Markdown>{input.text}</Markdown>
        </div>
        {answer?.kind === "not-sent" && <Refusal message={answer.message} />}
        {answer?.kind === "sent" && (
          <Text as="p" variant="caption" tone="muted">
            {sentence(DELIVERIES[answer.delivery])}
          </Text>
        )}
        {answer?.kind === "text" && (
          <Text as="p" variant="caption" tone="muted">
            {answer.text}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}
