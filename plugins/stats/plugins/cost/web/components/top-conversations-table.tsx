import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ChartState } from "@plugins/stats/plugins/commits/web";
import {
  useEndpoint,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { getCostSessions } from "../../shared/endpoints";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { formatTokensCompact, formatUsd } from "../../core";
import { useScope } from "./use-scope";

interface Row {
  sessionId: string;
  conversationId: string | null;
  title: string | null;
  status: string | null;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  lastActivity: string;
  modelsUsed: string[];
}

export function TopConversationsTable() {
  const { scope } = useScope();
  const { data: resp, error } = useEndpoint(
    getCostSessions,
    {},
    { query: { scope, limit: "50" } },
  );
  return (
    <ChartState
      error={error ? getEndpointErrorMessage(error) : null}
      loading={resp === undefined}
      empty={!!resp && resp.rows.length === 0}
    >
      <Scroll axis="x">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b text-left text-caption text-muted-foreground">
              <th className="px-sm py-xs font-medium">Conversation</th>
              <th className="px-sm py-xs font-medium">Model(s)</th>
              <th className="px-sm py-xs text-right font-medium">Cost</th>
              <th className="px-sm py-xs text-right font-medium">Tokens</th>
              <th className="px-sm py-xs font-medium">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {resp?.rows.map((r) => (
              <TopRow key={r.sessionId} row={r} />
            ))}
          </tbody>
        </table>
      </Scroll>
    </ChartState>
  );
}

function TopRow({ row }: { row: Row }) {
  const openPane = useOpenPane();
  const totalTokens =
    row.inputTokens +
    row.outputTokens +
    row.cacheCreationTokens +
    row.cacheReadTokens;
  const target =
    row.conversationId === null
      ? undefined
      : openPane.to(
          conversationPane,
          { convId: row.conversationId },
          { mode: "push" },
        );
  const isClickable = target !== undefined;
  return (
    <tr
      {...activationProps(target)}
      className={cn(
        "border-b border-border/50",
        isClickable && "cursor-pointer hover:bg-muted/50",
      )}
    >
      <td className="px-sm py-xs">
        <Stack direction="row" gap="sm" align="baseline">
          <span className="truncate font-medium text-foreground">
            {row.title ?? <UntitledLabel sessionId={row.sessionId} />}
          </span>
          {row.status && (
            <span className="text-caption text-muted-foreground">
              {row.status}
            </span>
          )}
        </Stack>
      </td>
      <td className="px-sm py-xs text-caption text-muted-foreground">
        {row.modelsUsed.join(", ")}
      </td>
      <td className="px-sm py-xs text-right font-mono tabular-nums">
        {formatUsd(row.totalCost)}
      </td>
      <td className="px-sm py-xs text-right font-mono tabular-nums text-muted-foreground">
        {formatTokensCompact(totalTokens)}
      </td>
      <td className="px-sm py-xs text-caption text-muted-foreground">
        {row.lastActivity}
      </td>
    </tr>
  );
}

function UntitledLabel({ sessionId }: { sessionId: string }) {
  return (
    <span className="font-mono text-caption text-muted-foreground">
      {sessionId.slice(0, 8)}…
    </span>
  );
}
