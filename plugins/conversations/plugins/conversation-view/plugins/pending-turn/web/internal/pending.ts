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
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { landedTurnIds } from "./landed";
import { settleSentTurns, useSentTurns, type SentTurn } from "./send";

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
  state: PendingTurnState;
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
 *   echo, until the TRANSCRIPT shows the turn (`landedTurnIds`): the echo
 *   stands in for the message, so only the message retires it — never the
 *   ledger's word, which reaches the tab on another channel;
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
 * shows it, or — a hookless turn (a slash command, a `!` line) — the box took
 * it, which is all anything will ever say about it.
 */
function echoRetired(row: LedgerTurn, landed: ReadonlySet<string>): boolean {
  if (CARD_OF[row.state] !== "echo") return false;
  return landed.has(row.id) || (row.hookless && row.state === "typed");
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
  const landed = landedTurnIds(newestFirst, events);
  const fromLedger: PendingTurn[] = newestFirst
    .filter(
      (row) =>
        CARD_OF[row.state] !== null &&
        !echoRetired(row, landed) &&
        (row.state !== "merged" || row.id === newestId),
    )
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      text: row.text,
      state: row.state,
      extraText: row.extraText,
      error: row.error,
    }))
    .reverse();
  const fromTab: PendingTurn[] = unseen.map((turn) => ({
    id: turn.id,
    kind: turn.kind,
    text: turn.text,
    state: turn.status.kind === "unsent" ? "unsent" : "sending",
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
  // The rows this tab holds, to retire the sends they stand for: none yet
  // while loading, the last known ones over a failed read.
  const rows = foldResource(ledger, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (data) => data,
  });
  useEffect(() => {
    if (rows) settleSentTurns(conversationId, new Set(rows.map((r) => r.id)));
  }, [conversationId, rows]);
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
 * hooked row is being typed or awaits its hook — sent since the server's
 * status last moved (`updatedAt`), so a row whose hook never comes cannot hold
 * it once the server has spoken.
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
        !row.hookless &&
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
  const recent = useLive(conversationTurns);
  const sent = useSentTurns(conversation.id);
  if (conversation.status !== "waiting") return conversation.status;
  const rows = foldResource(recent, {
    loading: () => [],
    error: (_error, stale) => stale ?? [],
    ready: (data) => data,
  });
  return runsAheadOfServer(conversation, rows, sent)
    ? "working"
    : conversation.status;
}
