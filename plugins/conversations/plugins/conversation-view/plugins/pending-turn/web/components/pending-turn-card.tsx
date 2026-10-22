import type { ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { WorkingText } from "@plugins/primitives/plugins/css/plugins/working-dots/web";
import { UserMessageText } from "@plugins/conversations/plugins/conversation-view/plugins/user-message/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";
import {
  getEndpointErrorMessage,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { writeDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { conversationPromptDraft } from "../internal/prompt-draft";
import type { PendingTurn } from "../internal/pending";
import { useDismissSentTurn, useResendTurn } from "../internal/send";
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

/** What a card's Retry / Copy to draft run, bound to the card's transport. */
interface CardActions {
  retry(turn: PendingTurn): Promise<void>;
  takeBack(turn: PendingTurn): Promise<void>;
}

/**
 * The card's actions over the subtree's transport: a turn that never reached
 * the server goes through the tab's own store (re-sent under its id, or
 * forgotten), a ledger row through the server's retry / withdraw endpoints.
 */
function useCardActions(conversationId: string): CardActions {
  const fetchEndpoint = useFetchEndpoint();
  const resendTurn = useResendTurn();
  const dismissSentTurn = useDismissSentTurn();
  return {
    retry(turn) {
      if (turn.state === "unsent") {
        resendTurn(conversationId, turn.id);
        return Promise.resolve();
      }
      // A retry that fails again is written on the row (`failed`, with its
      // error), which this card then shows; the toast says the click did
      // nothing.
      return act("Retry", () =>
        retryLedgerTurn(fetchEndpoint, conversationId, turn.id),
      );
    },
    takeBack(turn) {
      copyToDraft(conversationId, turn.text);
      if (turn.state === "unsent") {
        dismissSentTurn(conversationId, turn.id);
        return Promise.resolve();
      }
      return act("Copy to draft", () =>
        withdrawLedgerTurn(fetchEndpoint, conversationId, turn.id),
      );
    },
  };
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
 * Where an echo stands, in words, under the host's user row: muted, with a
 * highlight sweeping across it while the turn is on its way. It is the ONLY
 * thing an echo adds to the message — when the transcript takes the turn
 * over, this line is all that goes away.
 */
function EchoStatus({ caption }: { caption: string }) {
  return (
    <Text as="div" variant="caption">
      <WorkingText>{caption}</WorkingText>
    </Text>
  );
}

/**
 * Draws a turn still on its way exactly as its host draws the turn once the
 * transcript holds it — the same component, so nothing on screen changes but
 * `status` going away. `status` is the in-flight line ("Sending…"); the host
 * places it under the message, aligned as its own rows are.
 */
export type RenderEcho = (turn: PendingTurn, status: ReactNode) => ReactNode;

/**
 * One turn's card at the end of the transcript, by state (replace, never
 * duplicate — a turn the transcript shows has no card; see `pendingTurnsOf`
 * for which turns get one):
 *
 * - `sending` / `held` / `typing` / `typed` / `accepted` — the echo, drawn by
 *   the host (`renderEcho`) as its own user row, with the in-flight status
 *   under it, until the transcript shows the turn;
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
  renderEcho,
}: {
  conversationId: string;
  turn: PendingTurn;
  /** The conversation is `starting`: every echo waits for the agent. */
  agentStarting: boolean;
  /** The host's own user row, so the echo cannot look unlike the message it becomes. */
  renderEcho: RenderEcho;
}) {
  const actions = useCardActions(conversationId);
  const card = turn.card;
  const inFlight = card === "echo";
  const failed = card === "failure";
  useReportSync({
    phase: failed ? "error" : inFlight ? "syncing" : "idle",
    label: "message",
    retry: failed ? () => void actions.retry(turn) : undefined,
    savedAt: null,
  });

  if (inFlight) {
    return renderEcho(
      turn,
      <EchoStatus caption={echoCaption(turn, agentStarting)} />,
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
          <Button variant="outline" onClick={() => actions.retry(turn)}>
            Retry
          </Button>
          <Button variant="ghost" onClick={() => actions.takeBack(turn)}>
            Copy to draft
          </Button>
        </Stack>
      </Stack>
    </div>
  );
}
