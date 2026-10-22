import { useState, type ReactElement } from "react";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  DataView,
  defineDataView,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  limitReached,
  limitStoppedConversations,
  resumeLimitedConversations,
  weekRoom,
  type ClaudeUsageRead,
  type LimitStoppedConversation,
  type ResumeLimitedResult,
} from "../../core";
import { formatResets } from "../internal/claude-usage";

// The conversations an account's usage limit stopped, in the Claude Code row:
// how many, the list (each opens its conversation), and Resume all — one
// resume turn each, whose send restarts the agent on the account a launch
// picks now (`launchAccountId`).

const LIMIT_STOPPED_VIEW = defineDataView("runtime-sdk.limit-stopped");

const limitStoppedSource = liveDataSource(limitStoppedConversations, {
  searchable: ["title"],
});

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

function failureOf(r: ResumeLimitedResult): { id: string; message: string }[] {
  return r.kind === "failed" ? [{ id: r.id, message: r.message }] : [];
}

export function LimitStoppedBanner({
  stopped,
  launchAccountId,
  launchAccountName,
  usage,
  now,
}: {
  stopped: readonly LimitStoppedConversation[];
  /** The account an agent restarted now runs on. */
  launchAccountId: string;
  launchAccountName: string;
  usage: ClaudeUsageRead;
  now: number;
}): ReactElement | null {
  const openPane = useOpenPane();
  const [failed, setFailed] = useState<{ id: string; message: string }[]>([]);
  if (stopped.length === 0) return null;
  const reading = usage.byAccount[launchAccountId];
  const reached = limitReached(reading, now);
  const room = weekRoom(reading, now);
  const resumeAll = async () => {
    const answer = await fetchEndpoint(
      resumeLimitedConversations,
      {},
      { body: { ids: stopped.map((c) => c.id) } },
    );
    if (answer.kind === "unavailable") {
      setFailed([{ id: "all", message: answer.message }]);
      return;
    }
    setFailed(answer.value.results.flatMap(failureOf));
  };
  return (
    <Stack
      gap="xs"
      className="rounded-md border border-warning/30 bg-warning/10 p-sm"
    >
      <Text variant="caption">
        {stopped.length === 1
          ? "1 conversation"
          : `${stopped.length} conversations`}{" "}
        stopped at a usage limit
      </Text>
      <DataView<LimitStoppedConversation>
        storageKey={LIMIT_STOPPED_VIEW}
        views={["list"]}
        source={limitStoppedSource}
        rowActivation={(c) =>
          openPane.to(conversationPane, { convId: c.id }, { mode: "push" })
        }
      />
      <Line>
        {reached ? (
          <Text variant="caption" tone="muted">
            No account has room · {launchAccountName}{" "}
            {formatResets(reached.id, reached.resetsAt, now)}
          </Text>
        ) : null}
        <Fill />
        <Button disabled={reached !== null} onClick={resumeAll}>
          Resume all on {launchAccountName}
          {room.kind === "known" ? ` · ${percent(room.left)} left` : ""}
        </Button>
      </Line>
      {failed.map((f) => (
        <Text key={f.id} variant="caption" tone="destructive">
          {f.id}: {f.message}
        </Text>
      ))}
    </Stack>
  );
}
