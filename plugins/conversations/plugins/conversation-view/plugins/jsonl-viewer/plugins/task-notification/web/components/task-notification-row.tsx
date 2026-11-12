import { useState, type ReactNode } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { FieldsCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/fields-card/web";
import { useJsonlConversationId } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import {
  TaskNotification,
  type TaskNotificationClaim,
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
 * Resolves which `TaskNotification.Open` contribution claims this notification
 * and hands the answer to `children`: the first claim, `pending` while a
 * contributor is still answering, or `declined` when nobody claims it. The row
 * names no kind of task — which pane a sub-agent or a shell opens, and what it
 * shows inside the card, is its owning plugin's to say.
 *
 * Asked one contribution per component, in order, so each renders exactly one
 * claim hook (the contribution list is fixed for a session, and each link is
 * keyed by its contribution's id). A contributor still answering holds the
 * chain: a later one must not claim what may be its task.
 */
function ResolveClaim({
  event,
  children,
}: {
  event: TaskNotificationEvent;
  children: (claim: TaskNotificationClaim) => ReactNode;
}) {
  const contributions = TaskNotification.Open.useContributions();
  const conversationId = useJsonlConversationId();
  return (
    <ClaimLink
      contributions={contributions}
      at={0}
      event={event}
      conversationId={conversationId}
      render={children}
    />
  );
}

const DECLINED: TaskNotificationClaim = { kind: "declined" };

function ClaimLink({
  contributions,
  at,
  event,
  conversationId,
  render,
}: {
  contributions: readonly TaskNotificationOpenContribution[];
  at: number;
  event: TaskNotificationEvent;
  conversationId: string | null;
  render: (claim: TaskNotificationClaim) => ReactNode;
}) {
  const contribution = contributions[at];
  if (contribution === undefined) return render(DECLINED);
  return (
    <ClaimStep
      key={contribution.id}
      useClaim={contribution.useClaim}
      event={event}
      conversationId={conversationId}
      render={render}
      next={
        <ClaimLink
          contributions={contributions}
          at={at + 1}
          event={event}
          conversationId={conversationId}
          render={render}
        />
      }
    />
  );
}

function ClaimStep({
  useClaim,
  event,
  conversationId,
  render,
  next,
}: {
  useClaim: TaskNotificationOpenContribution["useClaim"];
  event: TaskNotificationEvent;
  conversationId: string | null;
  render: (claim: TaskNotificationClaim) => ReactNode;
  next: ReactNode;
}) {
  const claim = useClaim(event, conversationId);
  return claim.kind === "declined" ? next : render(claim);
}

/**
 * A finished background task, as a standard transcript card: the status and
 * summary on its header line, the output path and the owner's open button
 * beside them; opened, the summary in full, any extra fields, and what the
 * claiming plugin shows of the task (a shell's output) — mounted only once
 * opened, so nothing is read for a row nobody opens.
 */
export function TaskNotificationRow({ event }: { event: JsonlEvent }) {
  const e = event as TaskNotificationEvent;
  // Held here, not in the card: the card is drawn at the end of the claim
  // chain, so it can remount while the chain resolves — the open state must
  // survive that.
  const [open, setOpen] = useState(false);
  const dot = (
    <StatusDot colorClass={STATUS_DOT[e.status] ?? "bg-muted-foreground"} />
  );
  const fields = Object.entries(e.extra ?? {}).map(([key, value]) => ({
    key,
    value,
  }));
  return (
    <ResolveClaim event={e}>
      {(claim) => (
        <FieldsCard
          icon={dot}
          label={statusLabel(e.status)}
          summary={e.summary}
          fields={fields}
          aside={
            e.outputFile ? <FilePath filePath={e.outputFile} /> : undefined
          }
          trailing={
            claim.kind === "claimed" ? (
              <IconButton
                icon={claim.target.icon}
                label={claim.target.label}
                {...activationProps(claim.target.activation, { isolate: true })}
              />
            ) : undefined
          }
          open={open}
          onOpenChange={setOpen}
        >
          {claim.kind === "claimed" ? claim.target.body : undefined}
        </FieldsCard>
      )}
    </ResolveClaim>
  );
}
