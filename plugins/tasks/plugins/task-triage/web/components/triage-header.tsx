import type { ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  NOT_TRIAGED_META,
  TRIAGE_STATE_META,
  taskTriageReads,
  type TriageRead,
} from "../../core";
import { useRunTriage, useTriageRead } from "../internal/use-triage";
import { OptionBadge } from "./option-badge";

const conversationIcon = symbol("forum");
const rerunIcon = symbol("replay");

/**
 * The card's header line, shut or open: the state chip, then when — "Ran 2h
 * ago", "Started just now", "Queued · 2 ahead". Nothing until the row is known:
 * never a "Not triaged" chip that turns into a read a round trip later.
 */
export function TriageSummary({
  taskId,
}: {
  taskId: string;
}): ReactElement | null {
  const read = useTriageRead(taskId);
  return foldResource(read, {
    loading: () => null,
    // The body renders the failure (with its Retry); the header stays quiet.
    error: () => null,
    ready: (r) => <SummaryOf read={r} />,
  });
}

function SummaryOf({ read }: { read: TriageRead | null }): ReactElement {
  if (read === null) return <OptionBadge meta={NOT_TRIAGED_META} />;
  return (
    <Inline gap="sm">
      <OptionBadge meta={TRIAGE_STATE_META[read.state]} />
      <When read={read} />
    </Inline>
  );
}

function When({ read }: { read: TriageRead }): ReactElement | null {
  switch (read.state) {
    case "done":
    case "stale":
      return (
        <Text variant="caption" tone="muted">
          {"Ran "}
          <RelativeTime date={read.read.triagedAt} />
        </Text>
      );
    case "running":
      return read.startedAt === null ? null : (
        <Text variant="caption" tone="muted">
          {"Started "}
          <RelativeTime date={read.startedAt} />
        </Text>
      );
    case "queued":
      return (
        <QueuedAhead taskId={read.taskId} requestedAt={read.requestedAt} />
      );
    case "failed":
      return null;
  }
}

/**
 * How many queued requests are ahead of this one — the queued window, oldest
 * request first, counted up to this task's own request. Mounted only while
 * the task is queued, so no other state subscribes to the queue.
 */
function QueuedAhead({
  taskId,
  requestedAt,
}: {
  taskId: string;
  requestedAt: Date;
}): ReactElement | null {
  const queued = useLive(taskTriageReads, { where: { state: "queued" } });
  return foldResource(queued, {
    loading: () => null,
    error: () => null,
    ready: (rows) => {
      const ahead = rows.filter(
        (r) =>
          r.taskId !== taskId &&
          r.requestedAt.getTime() < requestedAt.getTime(),
      ).length;
      return (
        <Text variant="caption" tone="muted">
          {ahead === 0 ? "Next up" : `${ahead} ahead`}
        </Text>
      );
    },
  });
}

/**
 * The header's actions on the triage itself: **Conversation** (whenever a run
 * exists, running or not — it is where follow-up questions go) and
 * **Re-run** (on a current read; a stale or failed one offers it in the body).
 */
export function TriageActions({
  taskId,
}: {
  taskId: string;
}): ReactElement | null {
  const read = useTriageRead(taskId);
  const run = useRunTriage(taskId);
  if (read.status !== "ready" || read.data === null) return null;
  const r = read.data;
  return (
    <Inline gap="xs">
      {r.conversationId !== null ? (
        <ConversationButton conversationId={r.conversationId} />
      ) : null}
      {r.state === "done" ? (
        <Button variant="ghost" onClick={run}>
          <Icon icon={rerunIcon} />
          Re-run
        </Button>
      ) : null}
    </Inline>
  );
}

/** Open (or close) the run's conversation beside the task — to ask follow-ups. */
export function ConversationButton({
  conversationId,
}: {
  conversationId: string;
}): ReactElement {
  const opener = useConversationOpener();
  return (
    <Button
      variant="ghost"
      tooltip="Ask follow-up questions in the triage conversation"
      aria-pressed={opener.isOpen(conversationId)}
      {...activationProps(opener.toggle(conversationId))}
    >
      <Icon icon={conversationIcon} />
      Conversation
    </Button>
  );
}
