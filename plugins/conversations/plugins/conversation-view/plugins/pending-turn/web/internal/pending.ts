import { useEffect, useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  conversationTurns,
  type LedgerTurn,
  type TurnKind,
  type TurnState,
} from "@plugins/conversations/plugins/turn-ledger/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
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
 * - `sending` (tab only) / `held` / `typing` — the echo, until the CLI takes it;
 * - `merged` — the warning naming the other text (see `pendingTurnsOf`);
 * - `failed` / `unverified` / `unsent` (tab only) — Retry and Copy to draft.
 *
 * `typed` draws nothing: the CLI's box took the keystrokes, and only the hook
 * refines that — a `typed` row whose hook never comes must not nag. Nor do
 * `accepted` (the transcript shows the turn), `returned` and `withdrawn` (the
 * draft holds it).
 */
export const CARD_OF: Record<PendingTurnState, PendingCard | null> = {
  sending: "echo",
  held: "echo",
  typing: "echo",
  typed: null,
  accepted: null,
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
 * The cards a conversation's transcript ends with, oldest first: its ledger
 * rows (`newestFirst`, as the live window reads them) that still say
 * something, then this tab's sent turns no row stands for yet.
 *
 * A `merged` warning shows only while its turn is the newest: it explains the
 * reply the agent is giving now, and the next turn makes it history.
 */
export function pendingTurnsOf(
  newestFirst: readonly LedgerTurn[],
  sent: readonly SentTurn[],
): PendingTurn[] {
  const ledgerIds = new Set(newestFirst.map((row) => row.id));
  const unseen = sent.filter((turn) => !ledgerIds.has(turn.id));
  const newestId = unseen.length ? null : (newestFirst[0]?.id ?? null);
  const fromLedger: PendingTurn[] = newestFirst
    .filter(
      (row) =>
        CARD_OF[row.state] !== null &&
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
 * (`turn-ledger.turns`) merged with this tab's sends whose row has not arrived.
 * Loading until the ledger has answered.
 */
export function usePendingTurns(
  conversationId: string,
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
  return useMemo(
    () => mapResource(ledger, (data) => pendingTurnsOf(data, sent)),
    [ledger, sent],
  );
}

/**
 * The states in which a sent turn is on its way into a running agent: being
 * typed, or taken by its CLI. `held` is not (the conversation is starting, and
 * its own status says so), nor are the failures or a turn given back.
 */
const LIVE_SEND: Record<TurnState, boolean> = {
  held: false,
  typing: true,
  typed: true,
  accepted: true,
  merged: true,
  returned: false,
  failed: false,
  unverified: false,
  withdrawn: false,
};

/** When the newest turn on its way into the agent was sent, or null. */
export function latestLiveSendAt(
  conversationId: string,
  newestFirst: readonly LedgerTurn[],
  sent: readonly SentTurn[],
): number | null {
  let latest: number | null = null;
  for (const turn of sent) {
    if (turn.status.kind === "unsent") continue;
    latest = Math.max(latest ?? 0, turn.createdAt.getTime());
  }
  for (const row of newestFirst) {
    if (row.conversationId !== conversationId) continue;
    if (!LIVE_SEND[row.state]) continue;
    latest = Math.max(latest ?? 0, row.createdAt.getTime());
  }
  return latest;
}

/**
 * The conversation's status as the user should see it: `working` from the
 * instant a turn is sent, before the server has seen it start.
 *
 * The override holds only while the server reports `waiting` AND its row has
 * not moved since the send — `updatedAt` is touched exactly when the status
 * enters or leaves `working`, so a newer `updatedAt` means the server has
 * accounted for the turn and its status is authoritative again. A send that
 * fails (`unsent`, `failed`, `unverified`) retracts the override with it.
 *
 * It reads the ledger's newest turns across every conversation (the default
 * window, one subscription every row of a list shares): a turn the server has
 * not accounted for yet is always among the newest. Until that read answers,
 * the server's own status stands — it is the authority the override only runs
 * ahead of, never a stand-in for it.
 */
export function useOptimisticConversationStatus(conversation: {
  id: string;
  status: ConversationStatus;
  updatedAt: Date;
}): ConversationStatus {
  const recent = useLive(conversationTurns);
  const sent = useSentTurns(conversation.id);
  if (conversation.status !== "waiting") return conversation.status;
  // No ledger rows yet (or none past a failed read): the tab's own sends
  // alone can run ahead of the server's status.
  const rows = foldResource(recent, {
    loading: () => [],
    error: (_error, stale) => stale ?? [],
    ready: (data) => data,
  });
  const sentAt = latestLiveSendAt(conversation.id, rows, sent);
  return sentAt != null && sentAt > conversation.updatedAt.getTime()
    ? "working"
    : conversation.status;
}
