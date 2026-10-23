import { useEffect, useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  mapResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  conversationTurns,
  type LedgerTurn,
  type TurnKind,
  type TurnState,
} from "@plugins/conversations/plugins/turn-ledger/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type {
  ConversationStatus,
  ConversationWorkingOn,
} from "@plugins/tasks/plugins/tasks-core/core";
import { isTurnRunning } from "@plugins/conversations/core";
import { isSlashCommand, transcriptReachedAt, transcriptShows } from "./landed";
import { useSentTurns, useSettleSentTurns, type SentTurn } from "./send";

/**
 * Where a turn the transcript should show a card for stands: a ledger state,
 * or — before its row reached this tab — `sending` (the request is open or
 * done) / `unsent` (the request failed).
 */
export type PendingTurnState = TurnState | "sending" | "unsent";

/** One turn that renders a card at the end of the transcript. */
export interface PendingTurn {
  id: string;
  kind: TurnKind;
  /** What the user wrote — the echo, and what Copy to draft restores. */
  text: string;
  /** When the user sent it — the time the echo's row shows. */
  sentAt: Date;
  state: PendingTurnState;
  /** The card it draws — `CARD_OF[state]`, never null for a turn listed. */
  card: PendingCard;
  /** `merged` only: the text the CLI submitted around this turn's. */
  extraText: string | null;
  /** `failed` / `unverified` / `unsent`: why. */
  error: string | null;
}

/** The card a turn draws, by kind of card. */
export type PendingCard = "echo" | "merged" | "failure";

/**
 * The card each state draws — a Record, so a new state cannot be left out:
 * - `sending` (tab only) / `held` / `typing` / `typed` / `accepted` — the
 *   echo, until the agent confirmed the turn AND the transcript reached that
 *   moment (`transcriptShows`): the echo stands in for the message, so it
 *   retires only once the message is on screen — never on a guess;
 * - `merged` — the warning naming the other text (see `pendingTurnsOf`);
 * - `failed` / `unverified` / `unsent` (tab only) — Retry and Copy to draft.
 *
 * `returned` and `withdrawn` draw nothing: the draft holds them.
 */
export const CARD_OF: Record<PendingTurnState, PendingCard | null> = {
  sending: "echo",
  held: "echo",
  typing: "echo",
  typed: "echo",
  accepted: "echo",
  merged: "merged",
  returned: null,
  failed: "failure",
  unverified: "failure",
  withdrawn: null,
  unsent: "failure",
};

/** An `answer` draws no echo: its question card is its in-flight state. */
function draws(turn: { kind: TurnKind; state: PendingTurnState }): boolean {
  return !(turn.kind === "answer" && CARD_OF[turn.state] === "echo");
}

/**
 * Whether a ledger row's echo has nothing left to stand in for: the transcript
 * (reaching `reachedAt`) shows it, or — a slash command, which lands as no
 * prompt row — the agent confirmed taking it, which is all anything will ever
 * say about it.
 */
function echoRetired(row: LedgerTurn, reachedAt: number | null): boolean {
  if (CARD_OF[row.state] !== "echo") return false;
  return (
    transcriptShows(row, reachedAt) ||
    (isSlashCommand(row) && row.state === "accepted")
  );
}

/**
 * The cards a conversation's transcript ends with, oldest first: its ledger
 * rows (`newestFirst`, as the live window reads them) that still say
 * something, then this tab's sent turns no row stands for yet. `events` is the
 * transcript the pane renders: an echo shows until it holds the turn.
 *
 * A `merged` warning shows only while its turn is the newest: it explains the
 * reply the agent is giving now, and the next turn makes it history.
 */
export function pendingTurnsOf(
  newestFirst: readonly LedgerTurn[],
  sent: readonly SentTurn[],
  events: readonly JsonlEvent[],
): PendingTurn[] {
  const ledgerIds = new Set(newestFirst.map((row) => row.id));
  const unseen = sent.filter((turn) => !ledgerIds.has(turn.id));
  const newestId = unseen.length ? null : (newestFirst[0]?.id ?? null);
  const reachedAt = transcriptReachedAt(events);
  const fromLedger: PendingTurn[] = newestFirst
    .flatMap((row) => {
      const card = CARD_OF[row.state];
      if (
        card === null ||
        echoRetired(row, reachedAt) ||
        (row.state === "merged" && row.id !== newestId)
      ) {
        return [];
      }
      return [
        {
          id: row.id,
          kind: row.kind,
          text: row.text,
          sentAt: row.createdAt,
          state: row.state,
          card,
          extraText: row.extraText,
          error: row.error,
        },
      ];
    })
    .reverse();
  const fromTab: PendingTurn[] = unseen.map((turn) => ({
    id: turn.id,
    kind: turn.kind,
    text: turn.text,
    sentAt: turn.createdAt,
    state: turn.status.kind === "unsent" ? "unsent" : "sending",
    card: turn.status.kind === "unsent" ? "failure" : "echo",
    extraText: null,
    error: turn.status.kind === "unsent" ? turn.status.error : null,
  }));
  return [...fromLedger, ...fromTab].filter(draws);
}

/**
 * The turns a conversation's transcript ends with a card for — its live ledger
 * (`turn-ledger.turns`) merged with this tab's sends whose row has not arrived,
 * less the ones `events` (the transcript the caller renders) already shows.
 * Loading until the ledger has answered and the transcript is in: which
 * echoes still stand depends on both.
 */
export function usePendingTurns(
  conversationId: string,
  events: ResourceResult<readonly JsonlEvent[]>,
): ResourceResult<PendingTurn[]> {
  const ledger = useLive(conversationTurns, { where: { conversationId } });
  const sent = useSentTurns(conversationId);
  const settleSentTurns = useSettleSentTurns();
  // The rows this tab holds, to retire the sends they stand for: none yet
  // while loading, the last known ones over a failed read.
  const rows = foldResource(ledger, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (data) => data,
  });
  useEffect(() => {
    if (rows) settleSentTurns(conversationId, new Set(rows.map((r) => r.id)));
  }, [conversationId, rows, settleSentTurns]);
  const both = useCombinedResources({ ledger, events });
  return useMemo(
    () =>
      mapResource(both, (data) =>
        pendingTurnsOf(data.ledger, sent, data.events),
      ),
    [both, sent],
  );
}

/**
 * The states in which the server cannot know yet that a turn is running: being
 * typed, or typed with the CLI's hook still to come. From the hook on, the
 * server's own status is the authority — the status reconciler weighs the
 * CLI's confirmed submit (`turn-ledger` `submitted_at`) against the CLI's
 * idle/busy write. `held` is not (the conversation is starting, and its own
 * status says so), nor are the failures or a turn given back.
 */
const BEFORE_THE_SERVER_KNOWS: Record<TurnState, boolean> = {
  held: false,
  typing: true,
  typed: true,
  accepted: false,
  merged: false,
  returned: false,
  failed: false,
  unverified: false,
  withdrawn: false,
};

/**
 * Whether a turn sent to the conversation is running ahead of the server's
 * status: this tab's request is open (or done, its row not here yet), or a
 * row is being sent or awaits the agent's confirmation — sent since the
 * server's status last moved (`updatedAt`), so a row whose confirmation never
 * comes cannot hold it once the server has spoken.
 */
export function runsAheadOfServer(
  conversation: { id: string; updatedAt: Date },
  newestFirst: readonly LedgerTurn[],
  sent: readonly SentTurn[],
): boolean {
  const since = conversation.updatedAt.getTime();
  const ledgerIds = new Set(newestFirst.map((row) => row.id));
  const tabAhead = sent.some(
    (turn) =>
      turn.status.kind !== "unsent" &&
      !ledgerIds.has(turn.id) &&
      turn.createdAt.getTime() > since,
  );
  return (
    tabAhead ||
    newestFirst.some(
      (row) =>
        row.conversationId === conversation.id &&
        BEFORE_THE_SERVER_KNOWS[row.state] &&
        row.createdAt.getTime() > since,
    )
  );
}

/**
 * The conversation's status as the user should see it: `working` from the
 * instant a turn is sent, until the server can know about it. Once the CLI's
 * hook confirmed the turn, the server's status is the one answer (see
 * {@link runsAheadOfServer}), so every surface reads the same status.
 *
 * It reads the ledger's newest turns across every conversation (the default
 * window, one subscription every row of a list shares): a turn the server has
 * not accounted for yet is always among the newest. Until that read answers,
 * the tab's own sends alone run ahead — the server's status is the authority
 * the override only runs ahead of, never a stand-in for it.
 */
export function useOptimisticConversationStatus(conversation: {
  id: string;
  status: ConversationStatus;
  updatedAt: Date;
}): ConversationStatus {
  const ahead = useRunsAhead(conversation);
  if (conversation.status !== "waiting") return conversation.status;
  return ahead ? "working" : conversation.status;
}

/**
 * Whether a turn is running as the user should see it (`isTurnRunning`), from
 * the instant one is sent — the turn-level twin of
 * {@link useOptimisticConversationStatus}: a turn sent while the agent sits
 * idle between turns (waiting, or working only on background tasks) is
 * running before the server can know it.
 */
export function useTurnRunning(conversation: {
  id: string;
  status: ConversationStatus;
  workingOn: ConversationWorkingOn | null;
  updatedAt: Date;
}): boolean {
  const ahead = useRunsAhead(conversation);
  if (isTurnRunning(conversation)) return true;
  const idleBetweenTurns =
    conversation.status === "waiting" ||
    (conversation.status === "working" &&
      conversation.workingOn === "background");
  return idleBetweenTurns && ahead;
}

/** {@link runsAheadOfServer} over the ledger's newest turns and this tab's sends. */
function useRunsAhead(conversation: { id: string; updatedAt: Date }): boolean {
  const recent = useLive(conversationTurns);
  const sent = useSentTurns(conversation.id);
  const rows = foldResource(recent, {
    loading: () => [],
    error: (_error, stale) => stale ?? [],
    ready: (data) => data,
  });
  return runsAheadOfServer(conversation, rows, sent);
}

/**
 * The ledger states of a turn still waiting for a starting agent: held for it,
 * or riding its launch and not confirmed yet. What Stop takes back while the
 * conversation is `starting`.
 */
const AWAITS_START: Record<TurnState, boolean> = {
  held: true,
  typing: true,
  typed: true,
  accepted: false,
  merged: false,
  returned: false,
  failed: false,
  unverified: false,
  withdrawn: false,
};

/**
 * Whether a turn of this conversation is waiting for its agent to start — the
 * launch prompt, or a message sent since — so Stop has something to take back
 * while the conversation is `starting`. The same ledger window the transcript's
 * cards read ({@link usePendingTurns}), so the two never disagree.
 */
export function useTurnAwaitingStart(
  conversationId: string,
): ResourceResult<boolean> {
  const ledger = useLive(conversationTurns, { where: { conversationId } });
  return useMemo(
    () =>
      mapResource(ledger, (rows) =>
        rows.some((row) => AWAITS_START[row.state]),
      ),
    [ledger],
  );
}
