import { useMemo } from "react";
import {
  formatTokenCount,
  useJsonlConversationId,
  useTranscriptSubject,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  StatBadge,
  useTranscriptFold,
  useTranscriptRead,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { usageFold } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/plugins/usage/core";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useConversationSubagents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web";
import {
  allAgentRows,
  rowsUnder,
  type AgentBandRow,
} from "../internal/agent-rows";
import { useAgentsBandView } from "./band-view";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * How many agents this transcript launched, and — since the usage reading
 * beside it counts only the transcript's own output — what the transcript and
 * all of its agents produced together.
 *
 * In the conversation's own transcript it toggles the agents card above the
 * prompt box between what is running now and every agent the conversation
 * launched. Inside a sub-agent's pane it counts the agents THAT sub-agent
 * spawned and toggles nothing — the card is the conversation's, not its.
 *
 * Scrolled back into history it counts the agents launched by the row on
 * screen (their own totals are as of now — a sub-agent's transcript is not
 * anchored to the parent's reading position).
 *
 * Nothing renders while the reads land, nor when no agent was launched — the
 * strip only carries readings that say something.
 */
export function AgentsStat() {
  const conversationId = useJsonlConversationId();
  if (conversationId === null) return null;
  return <AgentsStatFor conversationId={conversationId} />;
}

function AgentsStatFor({ conversationId }: { conversationId: string }) {
  const subject = useTranscriptSubject();
  const { events, atEnd } = useTranscriptRead();
  // The transcript's own output up to the reading position — the usage stat's
  // fold, which also covers the events before the page's window.
  const usage = useTranscriptFold(usageFold);
  const ownOutputRead = foldResource(usage, {
    loading: () => null,
    error: () => null,
    ready: (state) => state.output,
  });
  const subagents = useConversationSubagents(conversationId);
  const { view, toggleShowAll } = useAgentsBandView(conversationId);

  const reading = useMemo(() => {
    if (subagents.kind !== "known" || ownOutputRead === null) return null;
    const under = rowsUnder(
      allAgentRows(subagents),
      subject.kind === "subagent" ? subject.agentId : null,
    );
    const lastAt = events.at(-1)?.at;
    const cutoff = atEnd || lastAt === undefined ? null : new Date(lastAt);
    const agents = under.filter(
      (row): row is AgentBandRow =>
        row.kind === "agent" && (cutoff === null || row.startedAt <= cutoff),
    );
    return {
      agents: agents.length,
      running: agents.filter((row) => row.state.kind === "running").length,
      ownOutput: ownOutputRead,
      agentsOutput: agents.reduce((sum, row) => sum + row.usage.output, 0),
    };
  }, [subagents, subject, events, atEnd, ownOutputRead]);

  if (subagents.kind === "failed") {
    return (
      <StatBadge tone="alert" tooltip={subagents.error.message}>
        agents unavailable
      </StatBadge>
    );
  }
  // Pending, unavailable (no sub-agent reads on this host) or no agents
  // launched: the strip carries nothing it cannot say.
  if (reading === null || reading.agents === 0) return null;

  const { agents, running, ownOutput, agentsOutput } = reading;
  const total = ownOutput + agentsOutput;
  const toggles = subject.kind === "conversation";
  const title = [
    `${plural(agents, "sub-agent", "sub-agents")}${running > 0 ? `, ${running} running` : ""}`,
    `Output tokens: ${ownOutput.toLocaleString()} here + ${agentsOutput.toLocaleString()} in sub-agents = ${total.toLocaleString()}`,
    ...(toggles
      ? [
          view.showAll
            ? "Click to show only the running agents above the prompt."
            : "Click to list every agent above the prompt.",
        ]
      : []),
  ].join("\n");
  const label = (
    <>
      {plural(agents, "agent", "agents")} · {formatTokenCount(total)} total
    </>
  );

  if (!toggles) return <StatBadge tooltip={title}>{label}</StatBadge>;
  return (
    <StatBadge
      as="button"
      tooltip={title}
      aria-pressed={view.showAll}
      onClick={toggleShowAll}
    >
      {label}
    </StatBadge>
  );
}
