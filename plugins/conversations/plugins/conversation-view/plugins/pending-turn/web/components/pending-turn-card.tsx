import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { BouncingDots } from "@plugins/primitives/plugins/css/plugins/bouncing-dots/web";
import {
  UserMessageCard,
  UserMessageText,
} from "@plugins/conversations/plugins/conversation-view/plugins/user-message/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";
import { getEndpointErrorMessage } from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { CARD_OF, type PendingTurn } from "../internal/pending";
import { dismissSentTurn, resendTurn } from "../internal/send";
import { retryLedgerTurn, withdrawLedgerTurn } from "../internal/delivery";

// Restore the turn's text into the conversation's shared prompt draft.
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

/** Run a card action against the server; a refusal is a toast, not a crash. */
async function act(verb: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    showToast({
      title: `${verb} failed`,
      description: getEndpointErrorMessage(err),
      variant: "error",
    });
  }
}

function retry(conversationId: string, turn: PendingTurn): Promise<void> {
  if (turn.state === "unsent") {
    resendTurn(conversationId, turn.id);
    return Promise.resolve();
  }
  // A retry that fails again is written on the row (`failed`, with its
  // error), which this card then shows; the toast says the click did nothing.
  return act("Retry", () => retryLedgerTurn(conversationId, turn.id));
}

function takeBack(conversationId: string, turn: PendingTurn): Promise<void> {
  copyToDraft(conversationId, turn.text);
  if (turn.state === "unsent") {
    dismissSentTurn(conversationId, turn.id);
    return Promise.resolve();
  }
  return act("Copy to draft", () =>
    withdrawLedgerTurn(conversationId, turn.id),
  );
}

/**
 * One turn's card at the end of the transcript, by state (replace, never
 * duplicate — a turn the transcript shows has no card; see `pendingTurnsOf`
 * for which turns get one):
 *
 * - `sending` / `held` / `typing` — the dimmed echo;
 * - `merged` — the CLI submitted this turn together with other text (a draft
 *   its input box still held): a warning naming that text;
 * - `failed` / `unverified` / `unsent` — Retry + Copy to draft, with why.
 */
export function PendingTurnCard({
  conversationId,
  turn,
}: {
  conversationId: string;
  turn: PendingTurn;
}) {
  const card = CARD_OF[turn.state];
  const inFlight = card === "echo";
  const failed = card === "failure";
  useReportSync({
    phase: failed ? "error" : inFlight ? "syncing" : "idle",
    label: "message",
    retry: failed ? () => void retry(conversationId, turn) : undefined,
    savedAt: null,
  });

  if (inFlight) {
    // The same card and text formatting as the confirmed user row (chips
    // included), dimmed as "pending", with the shared BouncingDots activity
    // indicator below.
    return (
      <Stack gap="sm" className="opacity-70">
        <UserMessageCard>
          <UserMessageText text={turn.text} />
          <Text as="div" variant="caption" className="text-muted-foreground/60">
            {turn.state === "held"
              ? "Waiting for the agent to start…"
              : "Sending…"}
          </Text>
        </UserMessageCard>
        <Stack direction="row" gap="sm" align="center" className="px-xs py-xs">
          <BouncingDots />
        </Stack>
      </Stack>
    );
  }

  if (card === "merged") {
    return (
      <div className="rounded-md border border-warning/40 bg-warning/5 px-md py-sm">
        <Stack gap="xs">
          <Text as="div" variant="caption" className="text-warning">
            The agent received this message together with other text that was
            still in its input box:
          </Text>
          <UserMessageText text={turn.extraText ?? ""} />
        </Stack>
      </div>
    );
  }

  if (!failed) return null;
  const destructive = turn.state !== "unverified";
  const caption =
    turn.state === "unverified"
      ? `Not confirmed — the agent may not have received this message${turn.error ? ` (${turn.error})` : ""}. Check the terminal.`
      : `Failed to send${turn.error ? ` — ${turn.error}` : ""}`;
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
        <UserMessageText text={turn.text} />
        <Text
          as="div"
          variant="caption"
          className={destructive ? "text-destructive" : "text-warning"}
        >
          {caption}
        </Text>
        <Stack direction="row" gap="sm">
          <Button variant="outline" onClick={() => retry(conversationId, turn)}>
            Retry
          </Button>
          <Button
            variant="ghost"
            onClick={() => takeBack(conversationId, turn)}
          >
            Copy to draft
          </Button>
        </Stack>
      </Stack>
    </div>
  );
}
