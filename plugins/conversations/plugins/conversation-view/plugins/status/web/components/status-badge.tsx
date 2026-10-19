import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { formatStatusLabel } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { HeaderChip } from "@plugins/conversations/plugins/conversation-view/plugins/header/web";
import { useOptimisticConversationStatus } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import type { ConversationEntry } from "@plugins/conversations/core";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
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
  if (status === "gone") return <GoneChip conversationId={conversation.id} />;
  return (
    <HeaderChip colorClass={STATUS_CLASSES[status]}>
      {prettify(status)}
    </HeaderChip>
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
