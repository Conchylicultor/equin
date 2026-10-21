import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  UserMessageCard,
  UserMessageText,
} from "@plugins/conversations/plugins/conversation-view/plugins/user-message/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";
import { getEndpointErrorMessage } from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { writeDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { conversationPromptDraft } from "../internal/prompt-draft";
import type { PendingTurn } from "../internal/pending";
import { dismissSentTurn, resendTurn } from "../internal/send";
import { retryLedgerTurn, withdrawLedgerTurn } from "../internal/delivery";

// Restore the turn's text into the conversation's shared prompt draft — the
// store prompt-input's useDraft reads, which picks the write up through the
// store's subscription.
function copyToDraft(conversationId: string, text: string): void {
  writeDraft(conversationPromptDraft, text, { scope: conversationId });
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

const WAITING_FOR_START = "Waiting for the agent to start…";

/**
 * What an echo says where its turn is: `held` before the agent is up, `typed`
 * while it sits in the agent's input queue (a busy agent takes it when its
 * current step ends — the transcript shows it there as Queued); every other
 * echo state is still on its way. While the agent is starting, every echo is
 * waiting for it — the launch message is already `typing` as the agent comes
 * up, which is not "Sending…" to the user.
 */
const ECHO_CAPTION: Partial<Record<PendingTurn["state"], string>> = {
  held: WAITING_FOR_START,
  typed: "Waiting for the agent to take it…",
};

function echoCaption(turn: PendingTurn, agentStarting: boolean): string {
  if (agentStarting) return WAITING_FOR_START;
  return ECHO_CAPTION[turn.state] ?? "Sending…";
}

/**
 * One turn's card at the end of the transcript, by state (replace, never
 * duplicate — a turn the transcript shows has no card; see `pendingTurnsOf`
 * for which turns get one):
 *
 * - `sending` / `held` / `typing` / `typed` / `accepted` — the dimmed echo,
 *   until the transcript shows the turn;
 * - `merged` — the CLI submitted this turn together with other text (a draft
 *   its input box still held): a warning naming that text;
 * - `failed` / `unverified` / `unsent` — Retry + Copy to draft, with why.
 *
 * The card is the message only: what the agent is doing (starting, working)
 * is the host's one activity line at the foot of the transcript.
 */
export function PendingTurnCard({
  conversationId,
  turn,
  agentStarting,
}: {
  conversationId: string;
  turn: PendingTurn;
  /** The conversation is `starting`: every echo waits for the agent. */
  agentStarting: boolean;
}) {
  const card = turn.card;
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
    // included), dimmed as "pending".
    return (
      <div className="opacity-70">
        <UserMessageCard>
          <UserMessageText text={turn.text} />
          <Text as="div" variant="caption" className="text-muted-foreground/60">
            {echoCaption(turn, agentStarting)}
          </Text>
        </UserMessageCard>
      </div>
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
