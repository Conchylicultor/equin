import type { ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { WorkingText } from "@plugins/primitives/plugins/css/plugins/working-dots/web";
import { UserMessageText } from "@plugins/conversations/plugins/conversation-view/plugins/user-message/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
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
import {
  retryLedgerTurn,
  sendQueuedNow,
  withdrawLedgerTurn,
} from "../internal/delivery";

const scheduleIcon = symbol("schedule");

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
  sendNow(): Promise<void>;
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
    sendNow() {
      return act("Send now", () =>
        sendQueuedNow(fetchEndpoint, conversationId),
      );
    },
  };
}

const WAITING_FOR_START = "Waiting for the agent to start…";

/**
 * What an echo says where its turn is: `held` before the agent is up; every
 * other echo state is still on its way. While the agent is starting, every
 * echo is waiting for it — the launch message is already `typing` as the agent
 * comes up, which is not "Sending…" to the user. A `typed` turn while a turn
 * runs is queued instead (see `isQueued`). An `event` turn says it is one: the
 * app sent it, not the user.
 */
function echoCaption(turn: PendingTurn, agentStarting: boolean): string {
  const where =
    agentStarting || turn.state === "held" ? WAITING_FOR_START : "Sending…";
  return turn.kind === "event" ? `Event · ${where}` : where;
}

/**
 * Whether the echo's turn waits in the agent's queue: the agent has it
 * (`typed`) but a running turn holds it until the next tool boundary or its
 * end — when the CLI starts it, the ledger confirms it and the transcript's
 * message takes over.
 */
function isQueued(turn: PendingTurn, turnRunning: boolean): boolean {
  return turnRunning && turn.state === "typed";
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
 * A queued echo's line: it is not on its way but parked, so it sits still —
 * Queued, and Send now (interrupt the running turn so it starts at once).
 */
function QueuedStatus({ onSendNow }: { onSendNow: () => Promise<void> }) {
  return (
    <Stack direction="row" gap="xs" align="center">
      <Text as="div" variant="caption">
        <Stack direction="row" gap="xs" align="center">
          <Icon icon={scheduleIcon} className="size-3" />
          Queued
        </Stack>
      </Text>
      <ControlSizeProvider size="xs">
        <Button variant="ghost" onClick={onSendNow}>
          Send now
        </Button>
      </ControlSizeProvider>
    </Stack>
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
 *   under it — Queued · Send now while it waits for a running turn — until
 *   the transcript shows the turn. Mounted after the transcript, it stays
 *   last as the agent's steps land above it;
 * - `failed` / `unsent` — Retry + Copy to draft, with why.
 *
 * The card is the message only: what the agent is doing (starting, working)
 * is the host's one activity line at the foot of the transcript.
 */
export function PendingTurnCard({
  conversationId,
  turn,
  agentStarting,
  turnRunning,
  renderEcho,
}: {
  conversationId: string;
  turn: PendingTurn;
  /** The conversation is `starting`: every echo waits for the agent. */
  agentStarting: boolean;
  /** A turn is running (`isTurnRunning`): a turn the agent has waits for it. */
  turnRunning: boolean;
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
      isQueued(turn, turnRunning) ? (
        <QueuedStatus onSendNow={actions.sendNow} />
      ) : (
        <EchoStatus caption={echoCaption(turn, agentStarting)} />
      ),
    );
  }

  const caption = `Failed to send${turn.error ? ` — ${turn.error}` : ""}`;
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-md py-sm">
      <Stack gap="xs">
        <UserMessageText text={turn.text} />
        <Text as="div" variant="caption" className="text-destructive">
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
