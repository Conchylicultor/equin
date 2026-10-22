import { useCallback, useSyncExternalStore } from "react";
import {
  fetchEndpointOver,
  getEndpointErrorMessage,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import {
  transportScoped,
  useTransportScoped,
} from "@plugins/primitives/plugins/networking/web";
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
// (`settle`), never by guessing from text. What an entry still says once its
// row exists is nothing: the reader shows the row.
//
// A POST that fails leaves the entry `unsent`. It may still have reached the
// server (a torn connection after the row was written): then its row arrives
// and wins, as for any entry. Otherwise its Retry re-sends under the same id,
// which the server treats as the same turn.
//
// One store per transport (`transportScoped`): a turn sent inside a demo scope
// is that scope's server's turn — its echo, its in-flight guard and its Retry
// live beside the scope's ledger, never beside the page's, even when the two
// name the same conversation id.
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
  /**
   * The fetcher it was sent with — its store's transport — so its delivery
   * and its Retry reach the server it was sent to.
   */
  fetchEndpoint: FetchEndpoint;
}

/** How a surface describes the turn it sends. */
export interface TurnSend {
  text: string;
  /** Which endpoint carries it — a plain user turn when omitted. */
  delivery?: TurnDelivery;
}

/** One transport's sent turns, by conversation. */
interface SentTurnStore {
  /** Mints the turn's id, records its echo and starts its delivery. */
  send(conversationId: string, send: TurnSend): TurnId;
  /** Sends an `unsent` turn again, under its own id. */
  resend(conversationId: string, turnId: string): void;
  /** Forgets an `unsent` turn (its text went back to the draft). */
  dismiss(conversationId: string, turnId: string): void;
  /**
   * Drops the settled entries whose ledger row this tab now holds. An entry
   * still `posting` stays: its open request is what `useTurnSendInFlight`
   * reports.
   */
  settle(conversationId: string, ledgerIds: ReadonlySet<string>): void;
  entries(conversationId: string): readonly SentTurn[];
  subscribe(conversationId: string, onChange: () => void): () => void;
}

const DELIVERY_TIMEOUT_MS = 30_000;
const EMPTY: readonly SentTurn[] = [];

/** A store whose turns are sent over `fetchEndpoint`. */
function createSentTurnStore(fetchEndpoint: FetchEndpoint): SentTurnStore {
  const sent = new Map<string, readonly SentTurn[]>();
  const listeners = new Map<string, Set<() => void>>();

  const entries = (conversationId: string): readonly SentTurn[] =>
    sent.get(conversationId) ?? EMPTY;

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
    const current = entries(conversationId);
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
        turn.fetchEndpoint,
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

  return {
    send(conversationId, { text, delivery = postTurnDelivery }) {
      const turn: SentTurn = {
        id: turnIdKind.mint(),
        conversationId,
        kind: delivery.kind,
        text,
        createdAt: new Date(),
        status: { kind: "posting" },
        delivery,
        fetchEndpoint,
      };
      commit(conversationId, [...entries(conversationId), turn]);
      deliver(turn);
      return turn.id;
    },
    resend(conversationId, turnId) {
      const turn = entries(conversationId).find((t) => t.id === turnId);
      if (turn?.status.kind !== "unsent") return;
      const posting = { ...turn, status: { kind: "posting" } as const };
      commit(
        conversationId,
        entries(conversationId).map((t) => (t.id === turnId ? posting : t)),
      );
      deliver(posting);
    },
    dismiss(conversationId, turnId) {
      const current = entries(conversationId);
      if (!current.some((t) => t.id === turnId)) return;
      commit(
        conversationId,
        current.filter((t) => t.id !== turnId),
      );
    },
    settle(conversationId, ledgerIds) {
      const current = entries(conversationId);
      const next = current.filter(
        (t) => t.status.kind === "posting" || !ledgerIds.has(t.id),
      );
      if (next.length !== current.length) commit(conversationId, next);
    },
    entries,
    subscribe(conversationId, onChange) {
      let set = listeners.get(conversationId);
      if (!set) listeners.set(conversationId, (set = new Set()));
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(conversationId);
      };
    },
  };
}

/** Each transport's store, its turns sent over that transport's fetcher. */
const stores = transportScoped((transport) => {
  const fetchEndpoint = fetchEndpointOver(transport);
  return createSentTurnStore(fetchEndpoint);
});

/** The enclosing subtree's store (its transport's). */
function useSentTurnStore(): SentTurnStore {
  return useTransportScoped(stores);
}

/**
 * THE entry point for sending a turn from the browser: mints the turn's id,
 * shows its echo at once and starts the request, over the calling subtree's
 * transport — a turn sent inside a demo scope reaches that scope's server,
 * never the page's. Returns the id immediately: the echo and then the ledger
 * row are the caller's feedback, so no surface needs its own in-flight state,
 * error toast or Retry.
 */
export function useSendConversationTurn(): (
  conversationId: string,
  send: TurnSend,
) => TurnId {
  const store = useSentTurnStore();
  return useCallback(
    (conversationId: string, send: TurnSend) =>
      store.send(conversationId, send),
    [store],
  );
}

/** Send an `unsent` turn again, under its own id, to the server it was sent to. */
export function useResendTurn(): (
  conversationId: string,
  turnId: string,
) => void {
  const store = useSentTurnStore();
  return useCallback(
    (conversationId: string, turnId: string) =>
      store.resend(conversationId, turnId),
    [store],
  );
}

/** Forget an `unsent` turn (its text went back to the draft). */
export function useDismissSentTurn(): (
  conversationId: string,
  turnId: string,
) => void {
  const store = useSentTurnStore();
  return useCallback(
    (conversationId: string, turnId: string) =>
      store.dismiss(conversationId, turnId),
    [store],
  );
}

/**
 * Drop the subtree's settled entries whose ledger row this tab now holds
 * (`SentTurnStore.settle`).
 */
export function useSettleSentTurns(): (
  conversationId: string,
  ledgerIds: ReadonlySet<string>,
) => void {
  const store = useSentTurnStore();
  return useCallback(
    (conversationId: string, ledgerIds: ReadonlySet<string>) =>
      store.settle(conversationId, ledgerIds),
    [store],
  );
}

/** This subtree's sent turns for a conversation, oldest first. */
export function useSentTurns(conversationId: string): readonly SentTurn[] {
  const store = useSentTurnStore();
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(conversationId, onChange),
    [store, conversationId],
  );
  const getSnapshot = useCallback(
    () => store.entries(conversationId),
    [store, conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/**
 * Whether a turn request this subtree sent to the conversation is still open —
 * the double-click guard of a button that sends a turn. Known at once: it
 * reads nothing from the server.
 */
export function useTurnSendInFlight(conversationId: string): boolean {
  return useSentTurns(conversationId).some((t) => t.status.kind === "posting");
}
