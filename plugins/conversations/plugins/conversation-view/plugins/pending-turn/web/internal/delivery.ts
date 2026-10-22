import {
  useMachineAvailability,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import type {
  MachineAvailability,
  MachineResult,
} from "@plugins/infra/plugins/endpoints/core";
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
// own endpoint, so there is nothing to look a delivery back up by. It names no
// transport: `send` runs over the fetcher the turn was sent with (the sending
// subtree's), so a turn sent inside a demo scope reaches that scope's server.
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
    fetchEndpoint: FetchEndpoint,
    conversationId: string,
    text: string,
    turnId: TurnId,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * Whether this subtree can send a turn at all: the turn endpoints need the
 * computer (`needsMachine`), so on a host without one (the demo's browser
 * server) every composer renders disabled with the `message` before a send
 * can start. The one reading of it, here beside the deliveries, so a composer
 * never names a turn endpoint itself.
 */
export function useTurnSendAvailability(): MachineAvailability {
  return useMachineAvailability(postConversationTurn);
}

/**
 * A turn endpoint needs the computer (`needsMachine`): on a host without one
 * (the demo) the composer is disabled before a send can start, so reaching
 * here is a bug — the delivery rejects with the sentence, never resolves as if
 * the server had recorded the turn.
 */
function delivered(result: MachineResult<unknown>): void {
  if (result.kind === "unavailable") throw new Error(result.message);
}

/** The default delivery: a user turn over `POST /api/conversations/:id/turn`. */
export const postTurnDelivery: TurnDelivery = {
  kind: "turn",
  async send(fetchEndpoint, conversationId, text, turnId, signal) {
    delivered(
      await fetchEndpoint(
        postConversationTurn,
        { id: conversationId },
        { body: { text, turnId }, signal },
      ),
    );
  },
};

/** Type a `failed` / `unverified` ledger row again (the server's Retry). */
export async function retryLedgerTurn(
  fetchEndpoint: FetchEndpoint,
  conversationId: string,
  turnId: string,
): Promise<void> {
  delivered(
    await fetchEndpoint(retryConversationTurn, { id: conversationId, turnId }),
  );
}

/** Take a `failed` / `unverified` ledger row back: it becomes `returned`. */
export async function withdrawLedgerTurn(
  fetchEndpoint: FetchEndpoint,
  conversationId: string,
  turnId: string,
): Promise<void> {
  delivered(
    await fetchEndpoint(withdrawConversationTurn, {
      id: conversationId,
      turnId,
    }),
  );
}
