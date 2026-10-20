import type { ReactNode } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { FieldsCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/fields-card/web";
import {
  EventLine,
  useJsonlConversationId,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import {
  TaskNotification,
  type TaskNotificationEvent,
  type TaskNotificationOpenContribution,
} from "../slots";

// Status colour rides a calm dot, never a filled badge, so the timeline stays
// quiet. Unknown statuses fall back to muted.
const STATUS_DOT: Record<string, string> = {
  completed: "bg-success",
  failed: "bg-destructive",
};

// "completed" → "Task completed". Natural case — jsonl-viewer bans all-caps.
function statusLabel(status: string): string {
  return status ? `Task ${status}` : "Task update";
}

/**
 * The button onto the task this notification ended: the first
 * `TaskNotification.Open` contribution that claims it, or nothing when none
 * does. The row names no kind of task — which pane a sub-agent or a shell
 * opens is its owning plugin's to say.
 *
 * Asked one contribution per component, in order, so each renders exactly one
 * claim hook (the contribution list is fixed for a session, and each link is
 * keyed by its contribution's id). A contributor still answering holds the
 * chain: a later one must not claim what may be its task.
 */
function OpenAction({ event }: { event: TaskNotificationEvent }) {
  const contributions = TaskNotification.Open.useContributions();
  const conversationId = useJsonlConversationId();
  return (
    <ClaimLink
      contributions={contributions}
      at={0}
      event={event}
      conversationId={conversationId}
    />
  );
}

function ClaimLink({
  contributions,
  at,
  event,
  conversationId,
}: {
  contributions: readonly TaskNotificationOpenContribution[];
  at: number;
  event: TaskNotificationEvent;
  conversationId: string | null;
}) {
  const contribution = contributions[at];
  if (contribution === undefined) return null;
  return (
    <ClaimStep
      key={contribution.id}
      useClaim={contribution.useClaim}
      event={event}
      conversationId={conversationId}
      next={
        <ClaimLink
          contributions={contributions}
          at={at + 1}
          event={event}
          conversationId={conversationId}
        />
      }
    />
  );
}

function ClaimStep({
  useClaim,
  event,
  conversationId,
  next,
}: {
  useClaim: TaskNotificationOpenContribution["useClaim"];
  event: TaskNotificationEvent;
  conversationId: string | null;
  next: ReactNode;
}) {
  const claim = useClaim(event, conversationId);
  switch (claim.kind) {
    case "pending":
      return null;
    case "declined":
      return next;
    case "claimed": {
      const { target } = claim;
      return (
        <IconButton
          icon={target.icon}
          label={target.label}
          {...activationProps(target.activation, { isolate: true })}
        />
      );
    }
  }
}

export function TaskNotificationRow({ event }: { event: JsonlEvent }) {
  const e = event as TaskNotificationEvent;
  const dot = (
    <StatusDot colorClass={STATUS_DOT[e.status] ?? "bg-muted-foreground"} />
  );
  const label = statusLabel(e.status);
  const hasExtra = !!e.extra && Object.keys(e.extra).length > 0;
  const open = <OpenAction event={e} />;

  // Arbitrary, potentially long `extra` fields fold behind the card's chevron so
  // the default stays a single quiet line; the summary rides the header's
  // truncating slot and is repeated in full inside the body — the shared
  // FieldsCard owns that whole shape.
  if (hasExtra) {
    return (
      <FieldsCard
        icon={dot}
        label={<span className="font-medium">{label}</span>}
        summary={e.summary}
        fields={Object.entries(e.extra ?? {}).map(([key, value]) => ({
          key,
          value,
        }))}
        aside={e.outputFile ? <FilePath filePath={e.outputFile} /> : undefined}
        trailing={open}
      />
    );
  }

  // No extra: a pure one-liner. A short output path rides inline as a chip
  // (FilePath truncates with an RTL ellipsis if it gets long).
  return (
    <EventLine icon={dot} label={label}>
      <span className="truncate">{e.summary}</span>
      {e.outputFile && <FilePath filePath={e.outputFile} />}
      {open}
    </EventLine>
  );
}
