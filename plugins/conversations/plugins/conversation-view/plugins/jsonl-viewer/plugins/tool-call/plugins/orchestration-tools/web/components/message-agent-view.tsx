import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { readMessageAnswer } from "../internal/parse";
import { AgentChip, Refusal } from "./target-chip";

type MessageAgentInput = { to: string; text: string; reopen?: boolean };

/** The message's first non-empty line — what the closed row previews. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

export function MessageAgentView({ event }: ToolRendererProps) {
  const input = event.input as MessageAgentInput;
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
            {answer.delivery}
          </Text>
        )}
        {answer?.kind === "unread" && (
          <Text as="p" variant="caption" tone="muted">
            {answer.text}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}
