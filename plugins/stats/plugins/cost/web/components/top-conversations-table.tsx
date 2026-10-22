import { useMemo } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { LiveChart } from "@plugins/stats/plugins/commits/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { formatTokensCompact, formatUsd } from "../../core";
import {
  costTopSessions,
  sessionConversations,
  type CostTopSession,
} from "../../shared/values";
import { useScope } from "./use-scope";

const TOP_SESSIONS_VIEW = defineDataView("stats.cost.top-sessions");

/**
 * One of the dearest sessions, joined to its live conversation where it still
 * exists (a rename or a status change reaches the row); a session whose
 * conversation is gone keeps the archive's snapshot.
 */
interface TopRow {
  sessionId: string;
  conversationId: string | null;
  title: string | null;
  /** The live conversation's status; null when it no longer exists. */
  status: string | null;
  models: string;
  cost: number;
  tokens: number;
  lastActivity: string;
}

const FIELDS: FieldDef<TopRow>[] = [
  {
    id: "conversation",
    label: "Conversation",
    type: "text",
    primary: true,
    value: (r) => r.title ?? r.sessionId,
    width: "minmax(0,1fr)",
    cell: (r) => (
      <Stack direction="row" gap="sm" align="baseline">
        {r.title !== null ? (
          <span className="truncate font-medium text-foreground">
            {r.title}
          </span>
        ) : (
          <span className="font-mono text-caption text-muted-foreground">
            {r.sessionId.slice(0, 8)}…
          </span>
        )}
        {r.status !== null && (
          <span className="text-caption text-muted-foreground">{r.status}</span>
        )}
      </Stack>
    ),
  },
  {
    id: "models",
    label: "Model(s)",
    type: "text",
    value: (r) => r.models,
    width: "10rem",
  },
  {
    id: "cost",
    label: "Cost",
    type: "number",
    value: (r) => r.cost,
    cell: (r) => (
      <span className="font-mono tabular-nums">{formatUsd(r.cost)}</span>
    ),
    align: "end",
    width: "6rem",
  },
  {
    id: "tokens",
    label: "Tokens",
    type: "number",
    value: (r) => r.tokens,
    cell: (r) => (
      <span className="font-mono tabular-nums text-muted-foreground">
        {formatTokensCompact(r.tokens)}
      </span>
    ),
    align: "end",
    width: "5rem",
  },
  {
    id: "lastActivity",
    label: "Last activity",
    type: "text",
    value: (r) => r.lastActivity,
    width: "7rem",
  },
];

export function TopConversationsTable() {
  const { scope } = useScope();
  const top = useLive(costTopSessions, { scope });
  return (
    <LiveChart
      read={top}
      subject="the top sessions"
      size="content"
      emptyText="No sessions recorded yet."
    >
      {({ rows }) => <TopSessions sessions={rows} />}
    </LiveChart>
  );
}

function TopSessions({ sessions }: { sessions: readonly CostTopSession[] }) {
  const openPane = useOpenPane();
  const conversations = useLive(sessionConversations, {
    ids: sessions.map((s) => s.sessionId),
  });
  // The rows are joined above the DataView, which gates on the lookup's own
  // state (`readiness`): they fold every state, only the ready arm renders.
  const found = foldResource(conversations, {
    loading: () => null,
    error: () => null,
    ready: (d) => d,
  });
  const rows = useMemo<TopRow[]>(() => {
    const bySession = new Map<
      string,
      { id: string; title: string | null; status: string }
    >();
    for (const c of found ?? []) {
      if (c.claudeSessionId !== null) bySession.set(c.claudeSessionId, c);
    }
    return sessions.map((s): TopRow => {
      const live = bySession.get(s.sessionId) ?? null;
      return {
        sessionId: s.sessionId,
        conversationId: live?.id ?? s.conversationId,
        title: live?.title ?? s.title,
        status: live?.status ?? null,
        models: s.modelsUsed.join(", "),
        cost: s.totalCost,
        tokens:
          s.inputTokens +
          s.outputTokens +
          s.cacheCreationTokens +
          s.cacheReadTokens,
        lastActivity: s.lastActivity,
      };
    });
  }, [sessions, found]);
  return (
    <DataView<TopRow>
      storageKey={TOP_SESSIONS_VIEW}
      rows={rows}
      readiness={conversations}
      rowKey={(r) => r.sessionId}
      fields={FIELDS}
      views={["table"]}
      defaultView="table"
      density="compact"
      rowActivation={(r) =>
        r.conversationId === null
          ? undefined
          : openPane.to(
              conversationPane,
              { convId: r.conversationId },
              { mode: "push" },
            )
      }
      emptyState="No sessions recorded yet."
    />
  );
}
