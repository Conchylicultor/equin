import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { formatStatusLabel } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { HeaderChip } from "@plugins/conversations/plugins/conversation-view/plugins/header/web";
import { useOptimisticConversationStatus } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import {
  STUCK_TURN_WAITING_FOR,
  type ConversationEntry,
} from "@plugins/conversations/core";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  describeSpawnFailure,
  FAILED_TO_START_LABEL,
  spawnFailureRows,
} from "@plugins/conversations/plugins/spawn-failure/core";

// Each status is a bordered pill; the live one (working) takes the accent for
// its text and outline, so the one conversation doing something reads at a glance.
const STATUS_CLASSES: Record<ConversationStatus, string> = {
  starting: "bg-muted text-muted-foreground border-border",
  working: "bg-muted text-primary-text border-primary/40",
  waiting: "bg-muted text-muted-foreground border-border",
  gone: "bg-warning/15 text-warning border-warning/30",
  done: "bg-muted text-muted-foreground/60 italic border-border",
};

const FAILED_CLASS = "bg-destructive/15 text-destructive border-destructive/30";
const STUCK_CLASS = "bg-warning/15 text-warning border-warning/30";
const UNKNOWN_CLASS =
  "bg-muted text-muted-foreground border-dashed border-border";

// Semantic overrides where the display word differs from the status key
// (not just casing). Everything else is sentence-cased via formatStatusLabel.
const STATUS_LABELS: Partial<Record<ConversationStatus, string>> = {
  gone: "Disconnected",
};

function prettify(status: ConversationStatus): string {
  return STATUS_LABELS[status] ?? formatStatusLabel(status);
}

export function StatusBadge() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  if (!conversation) return null;
  return <StatusChip conversation={conversation} />;
}

// Split out so the optimistic-status hook runs only once the row is known.
function StatusChip({ conversation }: { conversation: ConversationEntry }) {
  const status = useOptimisticConversationStatus(conversation);
  // The reconciler could not check the row against the agent: its status is
  // only the last known one, so the chip claims none. `done` is final.
  if (conversation.statusUnverifiedSince !== null && status !== "done")
    return (
      <UnknownChip
        since={conversation.statusUnverifiedSince}
        lastKnown={status}
      />
    );
  if (status === "gone") return <GoneChip conversationId={conversation.id} />;
  // Alive and at rest, holding a turn it never started: not idle, not working.
  if (
    status === "waiting" &&
    conversation.waitingFor === STUCK_TURN_WAITING_FOR
  )
    return (
      <WithTooltip content="Its agent is alive and at rest, but has held a message it was handed for minutes without starting it — its Claude Code looks wedged. The message starts if it recovers.">
        <span>
          <HeaderChip colorClass={STUCK_CLASS}>Stuck</HeaderChip>
        </span>
      </WithTooltip>
    );
  return (
    <HeaderChip colorClass={STATUS_CLASSES[status]}>
      {prettify(status)}
    </HeaderChip>
  );
}

function UnknownChip({
  since,
  lastKnown,
}: {
  since: Date;
  lastKnown: ConversationStatus;
}) {
  return (
    <WithTooltip
      content={`Status unverified since ${formatRelativeTime(since)} — this backend could not check it against the agent (it has not caught up with the agent's events, or the agent runtime did not answer). Last known: ${prettify(lastKnown)}.`}
    >
      <span>
        <HeaderChip colorClass={UNKNOWN_CLASS}>Unknown</HeaderChip>
      </span>
    </WithTooltip>
  );
}

// A gone conversation is either Disconnected (it ran; resumable from its
// session) or Failed to start (its spawn job recorded a failure) — which one is
// not known until the failure row is read, so nothing renders before.
function GoneChip({ conversationId }: { conversationId: string }) {
  const failure = useLiveRow(spawnFailureRows, conversationId);
  if (failure.status === "loading") return null;
  if (failure.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the conversation's launch status"
        error={failure.error}
        refetch={failure.refetch}
      />
    );
  if (!failure.found)
    return (
      <HeaderChip colorClass={STATUS_CLASSES.gone}>
        {prettify("gone")}
      </HeaderChip>
    );
  return (
    <WithTooltip content={describeSpawnFailure(failure.row)}>
      <span>
        <HeaderChip colorClass={FAILED_CLASS}>
          {FAILED_TO_START_LABEL}
        </HeaderChip>
      </span>
    </WithTooltip>
  );
}
