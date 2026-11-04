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
import { useLive, rowOrStale } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  Button,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  describeSpawnFailure,
  FAILED_TO_START_LABEL,
  spawnFailureRows,
  type SpawnFailure,
} from "@plugins/conversations/plugins/spawn-failure/core";
import { useState } from "react";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { conversationName } from "@plugins/tasks/plugins/tasks-core/core";
import { useMachineAvailability } from "@plugins/infra/plugins/endpoints/web";
import { useRetryLaunch } from "@plugins/conversations/plugins/conversation-view/plugins/resume/web";
import { retryLaunchEndpoint } from "@plugins/conversations/plugins/conversation-view/plugins/resume/core";

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
  const conversation = rowOrStale(useConversationById(convId));
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
  const failure = useLive(spawnFailureRows, { id: conversationId });
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
    <FailedToStartChip conversationId={conversationId} failure={failure.row} />
  );
}

const replayIcon = symbol("replay");

// A launch that never came up: the chip opens what failed and a Retry, which
// re-runs the launch (workspace, then agent) — the chip turns to Starting.
function FailedToStartChip({
  conversationId,
  failure,
}: {
  conversationId: string;
  failure: SpawnFailure;
}) {
  const conversation = rowOrStale(useConversationById(conversationId));
  const retry = useRetryLaunch();
  const machine = useMachineAvailability(retryLaunchEndpoint);
  const [open, setOpen] = useState(false);
  return (
    <InlinePopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width="card"
      padding="sm"
      trigger={
        <HeaderChip
          as="button"
          colorClass={FAILED_CLASS}
          aria-label="Failed to start — details and retry"
        >
          {FAILED_TO_START_LABEL}
        </HeaderChip>
      }
    >
      <Stack gap="sm">
        <Text as="p" variant="caption" className="break-words">
          {describeSpawnFailure(failure)}
        </Text>
        <Stack direction="row" align="center" justify="between" gap="sm">
          <Text as="span" variant="caption" className="text-muted-foreground">
            {formatRelativeTime(failure.failedAt)}
          </Text>
          <WithTooltip
            content={machine.available ? undefined : machine.message}
          >
            <span>
              <Button
                disabled={!machine.available || !conversation}
                onClick={async () => {
                  if (!conversation) return;
                  await retry({
                    id: conversation.id,
                    name: conversationName(conversation),
                  });
                  setOpen(false);
                }}
              >
                <Icon icon={replayIcon} />
                Retry
              </Button>
            </span>
          </WithTooltip>
        </Stack>
      </Stack>
    </InlinePopover>
  );
}
