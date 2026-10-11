import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { BouncingDots } from "@plugins/primitives/plugins/css/plugins/bouncing-dots/web";
import {
  UserMessageCard,
  UserMessageText,
} from "@plugins/conversations/plugins/conversation-view/plugins/user-message/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";
import {
  dismissPendingTurn,
  retryPendingTurn,
  type PendingTurnRecord,
} from "../internal/store";

// Restore the record's text into the conversation's shared prompt draft.
// persistent-draft exposes no non-hook setter, so this mirrors use-draft.ts's
// storage envelope + sync event exactly (key `singularity:draft:<key>:<scope>`,
// `{v, ts}` envelope, `singularity:draft-updated` custom event) — the editor's
// own useDraft hook picks the write up through that event.
function copyToDraft(conversationId: string, text: string): void {
  const sKey = `singularity:draft:conversation:prompt:${conversationId}`;
  try {
    localStorage.setItem(sKey, JSON.stringify({ v: text, ts: Date.now() }));
    // eslint-disable-next-line promise-safety/no-bare-catch -- quota exceeded: the failed card still holds the text; mirrors use-draft.ts
  } catch {
    // Quota exceeded — silently ignore
  }
  window.dispatchEvent(
    new CustomEvent("singularity:draft-updated", {
      detail: { storageKey: sKey },
    }),
  );
}

/**
 * Renders one pending-turn record by state (replace, never duplicate): a card
 * only for `sending | posted | held | failed-post | unconfirmed`, and nothing for
 * `queued`/`sent` — there the native queue-op row / real user-text row has
 * taken over the display. All feedback lives inside the card itself; a
 * reconciled message gets no extra indicator.
 *
 * `echo: false` records suppress the IN-FLIGHT card only — their surface shows
 * its own inline pending state (and the transcript may hide the delivered turn
 * entirely, as the AskUserQuestion answer does). Their failure card still
 * renders: a send that needs Retry must be reachable however it started, or the
 * silent surface becomes a second class of silent send — the exact thing this
 * plugin exists to eliminate.
 */
export function PendingTurnCard({
  conversationId,
  record,
}: {
  conversationId: string;
  record: PendingTurnRecord;
}) {
  const inFlight =
    record.state === "sending" ||
    record.state === "posted" ||
    record.state === "held";
  const failed =
    record.state === "failed-post" || record.state === "unconfirmed";
  useReportSync({
    phase: failed ? "error" : inFlight ? "syncing" : "idle",
    label: "message",
    retry: failed
      ? () => retryPendingTurn(conversationId, record.id)
      : undefined,
    savedAt: record.matchedAt ?? null,
  });

  if (record.state === "queued" || record.state === "sent") return null;
  if (inFlight && record.echo === false) return null;

  if (inFlight) {
    // The same card and text formatting as the confirmed user row (chips
    // included), dimmed as "pending", with the shared BouncingDots activity
    // indicator below.
    return (
      <Stack gap="sm" className="opacity-70">
        <UserMessageCard>
          <UserMessageText text={record.text} />
          <Text as="div" variant="caption" className="text-muted-foreground/60">
            {record.state === "sending"
              ? "Sending…"
              : record.state === "held"
                ? "Waiting for the agent to start…"
                : "Sent to CLI — confirming…"}
          </Text>
        </UserMessageCard>
        <Stack direction="row" gap="sm" align="center" className="px-xs py-xs">
          <BouncingDots />
        </Stack>
      </Stack>
    );
  }

  // failed-post | unconfirmed
  const destructive = record.state === "failed-post";
  const caption = destructive
    ? `Failed to send${record.errorMessage ? ` — ${record.errorMessage}` : ""}`
    : (record.errorMessage ??
      "Not confirmed — the agent may not have received this message. Check the terminal.");
  return (
    <div
      className={cn(
        "rounded-md border px-md py-sm",
        destructive
          ? "border-destructive/40 bg-destructive/5"
          : "border-warning/40 bg-warning/5",
      )}
    >
      <Stack gap="xs">
        <UserMessageText text={record.text} />
        <Text
          as="div"
          variant="caption"
          className={destructive ? "text-destructive" : "text-warning"}
        >
          {caption}
        </Text>
        <Stack direction="row" gap="sm">
          <Button
            variant="outline"
            onClick={() => retryPendingTurn(conversationId, record.id)}
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              copyToDraft(conversationId, record.text);
              dismissPendingTurn(conversationId, record.id);
            }}
          >
            Copy to draft
          </Button>
        </Stack>
      </Stack>
    </div>
  );
}
