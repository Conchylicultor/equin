import { useMemo } from "react";
import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { readAgentList } from "@plugins/tasks/plugins/orchestration/plugins/message/core";

/** The standing's headword (`idle (hibernated)` → `idle`, `working · status
 *  unverified` → `working`); the whole standing stays on hover. */
function headword(standing: string): string {
  return standing.split(/ \(| · /, 1)[0]!;
}

const STANDING_DOT: Record<string, string> = {
  starting: "bg-info/50",
  working: "bg-info",
  "waiting on the user": "bg-warning",
  stuck: "bg-warning",
  idle: "bg-muted-foreground/60",
  stopped: "bg-muted-foreground/40",
  closed: "bg-muted-foreground/25",
};

/** "3 working, 1 idle" — the agents' standings, most common first. */
function tally(standings: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const s of standings) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

/** `list_agents`'s input: its card draws from the result alone. */
export const ListAgentsInputSchema = z.looseObject({
  all: z.boolean().optional(),
});

export function ListAgentsView({
  event,
}: ToolViewProps<z.infer<typeof ListAgentsInputSchema>>) {
  const lines = useMemo(
    () => (event.result ? readAgentList(event.result.content) : []),
    [event.result],
  );
  const opener = useConversationOpener();
  const agents = lines.filter((l) => l.kind === "agent");

  return (
    <ToolCallCard
      event={event}
      summary={tally(agents.map((a) => headword(a.standing)))}
      note={
        agents.length > 0
          ? `· ${agents.length} agent${agents.length === 1 ? "" : "s"}`
          : undefined
      }
    >
      <Scroll className="max-h-[320px]">
        <Stack gap="none">
          {/* eslint-disable-next-line data-view/no-adhoc-row-list -- a snapshot of the agents as the agent read them (tool-result text), not a live record set */}
          {lines.map((line, i) => {
            if (line.kind === "text")
              return (
                <Text
                  key={`text-${i}`}
                  as="p"
                  variant="caption"
                  tone="muted"
                  className="px-row"
                >
                  {line.text}
                </Text>
              );
            const word = headword(line.standing);
            return (
              <Row
                key={line.conversationId}
                size="sm"
                icon={
                  <StatusDot
                    colorClass={STANDING_DOT[word] ?? "bg-muted-foreground/40"}
                  />
                }
                title={`${line.taskId} · ${line.conversationId}`}
                {...activationProps(opener.toggle(line.conversationId))}
              >
                <Fill as="span" className="truncate">
                  {line.title}
                </Fill>
                <Text
                  as="span"
                  variant="caption"
                  tone="muted"
                  className={rigidClass()}
                  title={line.standing}
                >
                  {word}
                </Text>
                {line.self && (
                  <Badge variant="info" className={rigidClass()}>
                    you
                  </Badge>
                )}
              </Row>
            );
          })}
        </Stack>
      </Scroll>
    </ToolCallCard>
  );
}
