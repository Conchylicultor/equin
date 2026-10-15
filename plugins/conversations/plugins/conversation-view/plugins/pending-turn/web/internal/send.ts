import { useCallback, useSyncExternalStore } from "react";
import { getEndpointErrorMessage } from "@plugins/infra/plugins/endpoints/web";
import {
  turnIdKind,
  type TurnId,
  type TurnKind,
} from "@plugins/conversations/plugins/turn-ledger/core";
import { postTurnDelivery, type TurnDelivery } from "./delivery";

// ---------------------------------------------------------------------------
// The browser's half of a send: the turns THIS tab sent whose ledger row it has
// not seen yet. The server's ledger (conversations/turn-ledger) is where a turn
// stands; this store only bridges the instant between the click and the live
// row, so the echo appears at once.
//
// An entry is keyed by the turn id the browser minted — the same id the
// server's row is written under — so the live row replaces its entry exactly
// (`settleSentTurns`), never by guessing from text. What an entry still says
// once its row exists is nothing: the reader shows the row.
//
// A POST that fails leaves the entry `unsent`. It may still have reached the
// server (a torn connection after the row was written): then its row arrives
// and wins, as for any entry. Otherwise its Retry re-sends under the same id,
// which the server treats as the same turn.
//
// In memory, per tab. Nothing here must survive a reload: a turn the server
// recorded is in the ledger, and one it never saw has nothing to recover but
// its text, which the user still has.
//
// Not `primitives/optimistic-mutation`: its overlay lives in the React state
// of the hook that dispatched, while a turn is sent from a button anywhere in
// the pane and echoed by the transcript, a different component.
// ---------------------------------------------------------------------------

export type SentTurnStatus =
  /** The request is open. */
  | { kind: "posting" }
  /** The server recorded it; its live row has not reached this tab yet. */
  | { kind: "posted" }
  /** The request failed: maybe never recorded. Retry re-sends the same id. */
  | { kind: "unsent"; error: string };

export interface SentTurn {
  id: TurnId;
  conversationId: string;
  kind: TurnKind;
  text: string;
  /** When the user sent it (this tab's clock). */
  createdAt: Date;
  status: SentTurnStatus;
  delivery: TurnDelivery;
}

const DELIVERY_TIMEOUT_MS = 30_000;
const EMPTY: readonly SentTurn[] = [];

const sent = new Map<string, readonly SentTurn[]>();
const listeners = new Map<string, Set<() => void>>();

function entriesOf(conversationId: string): readonly SentTurn[] {
  return sent.get(conversationId) ?? EMPTY;
}

function commit(conversationId: string, next: readonly SentTurn[]): void {
  if (next.length) sent.set(conversationId, next);
  else sent.delete(conversationId);
  for (const listener of listeners.get(conversationId) ?? []) listener();
}

function patch(
  conversationId: string,
  turnId: string,
  status: SentTurnStatus,
): void {
  const current = entriesOf(conversationId);
  if (!current.some((t) => t.id === turnId)) return;
  commit(
    conversationId,
    current.map((t) => (t.id === turnId ? { ...t, status } : t)),
  );
}

function deliver(turn: SentTurn): void {
  // Fire-and-forget: both outcomes land on the entry.
  void turn.delivery
    .send(
      turn.conversationId,
      turn.text,
      turn.id,
      AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    )
    .then(
      () => patch(turn.conversationId, turn.id, { kind: "posted" }),
      (err: unknown) =>
        patch(turn.conversationId, turn.id, {
          kind: "unsent",
          error: getEndpointErrorMessage(err),
        }),
    );
}

/** How a surface describes the turn it sends. */
export interface TurnSend {
  text: string;
  /** Which endpoint carries it — a plain user turn when omitted. */
  delivery?: TurnDelivery;
}

/**
 * THE entry point for sending a turn from the browser. Mints the turn's id,
 * shows its echo at once and starts the request. Returns the id immediately:
 * the echo and then the ledger row are the caller's feedback, so no surface
 * needs its own in-flight state, error toast or Retry.
 */
export function sendConversationTurn(
  conversationId: string,
  { text, delivery = postTurnDelivery }: TurnSend,
): TurnId {
  const turn: SentTurn = {
    id: turnIdKind.mint(),
    conversationId,
    kind: delivery.kind,
    text,
    createdAt: new Date(),
    status: { kind: "posting" },
    delivery,
  };
  commit(conversationId, [...entriesOf(conversationId), turn]);
  deliver(turn);
  return turn.id;
}

/** Send an `unsent` turn again, under its own id. */
export function resendTurn(conversationId: string, turnId: string): void {
  const turn = entriesOf(conversationId).find((t) => t.id === turnId);
  if (turn?.status.kind !== "unsent") return;
  const posting = { ...turn, status: { kind: "posting" } as const };
  commit(
    conversationId,
    entriesOf(conversationId).map((t) => (t.id === turnId ? posting : t)),
  );
  deliver(posting);
}

/** Forget an `unsent` turn (its text went back to the draft). */
export function dismissSentTurn(conversationId: string, turnId: string): void {
  const current = entriesOf(conversationId);
  if (!current.some((t) => t.id === turnId)) return;
  commit(
    conversationId,
    current.filter((t) => t.id !== turnId),
  );
}

/**
 * Drop the settled entries whose ledger row this tab now holds. An entry still
 * `posting` stays: its open request is what `useTurnSendInFlight` reports.
 */
export function settleSentTurns(
  conversationId: string,
  ledgerIds: ReadonlySet<string>,
): void {
  const current = entriesOf(conversationId);
  const next = current.filter(
    (t) => t.status.kind === "posting" || !ledgerIds.has(t.id),
  );
  if (next.length !== current.length) commit(conversationId, next);
}

/** This tab's sent turns for a conversation, oldest first. */
export function useSentTurns(conversationId: string): readonly SentTurn[] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let set = listeners.get(conversationId);
      if (!set) listeners.set(conversationId, (set = new Set()));
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(conversationId);
      };
    },
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => entriesOf(conversationId),
    [conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/**
 * Whether a turn request this tab sent to the conversation is still open — the
 * double-click guard of a button that sends a turn. Known at once: it reads
 * nothing from the server.
 */
export function useTurnSendInFlight(conversationId: string): boolean {
  return useSentTurns(conversationId).some((t) => t.status.kind === "posting");
}
