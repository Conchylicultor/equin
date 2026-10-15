import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  postConversationTurn,
  retryConversationTurn,
  withdrawConversationTurn,
} from "@plugins/conversations/core";
import type {
  TurnId,
  TurnKind,
} from "@plugins/conversations/plugins/turn-ledger/core";

// ---------------------------------------------------------------------------
// The delivery leg — the ONE thing that varies between the surfaces that send a
// turn: which endpoint carries it. Every delivery takes the turn id the browser
// minted, and the server records the turn's ledger row under it, so a repeated
// request is a no-op and the live row and the optimistic echo are one turn.
//
// A delivery is a plain value handed to `sendConversationTurn`: nothing about a
// turn outlives the tab but its ledger row, and Retry of a row is the server's
// own endpoint, so there is nothing to look a delivery back up by.
//
// The modules that build deliveries are the only web code allowed to import a
// turn endpoint (`turn-send-safety/no-adhoc-turn-send`, sanctioned per module
// in each plugin's `exempt/index.ts`).
// ---------------------------------------------------------------------------

export interface TurnDelivery {
  /** The ledger row's kind — an `answer` shows no in-flight echo. */
  kind: TurnKind;
  /**
   * Send the turn under `turnId`. MUST reject on failure; resolving means the
   * server recorded it (its ledger row carries the rest).
   */
  send(
    conversationId: string,
    text: string,
    turnId: TurnId,
    signal: AbortSignal,
  ): Promise<void>;
}

/** The default delivery: a user turn over `POST /api/conversations/:id/turn`. */
export const postTurnDelivery: TurnDelivery = {
  kind: "turn",
  async send(conversationId, text, turnId, signal) {
    await fetchEndpoint(
      postConversationTurn,
      { id: conversationId },
      { body: { text, turnId }, signal },
    );
  },
};

/** Type a `failed` / `unverified` ledger row again (the server's Retry). */
export async function retryLedgerTurn(
  conversationId: string,
  turnId: string,
): Promise<void> {
  await fetchEndpoint(retryConversationTurn, { id: conversationId, turnId });
}

/** Take a `failed` / `unverified` ledger row back: it becomes `returned`. */
export async function withdrawLedgerTurn(
  conversationId: string,
  turnId: string,
): Promise<void> {
  await fetchEndpoint(withdrawConversationTurn, {
    id: conversationId,
    turnId,
  });
}
