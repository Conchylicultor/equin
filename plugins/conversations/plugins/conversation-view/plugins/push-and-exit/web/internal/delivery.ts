import type { TurnDelivery } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { startPushAndExit } from "../../shared/endpoints";

/**
 * Push & Close delivers a turn like any other — the wrap-up prompt goes into
 * the same CLI input box and gets its own ledger row (kind `push-and-exit`). It
 * just travels over its own endpoint, because the server reads the prompt text
 * from config rather than trusting the client's copy; the echo shows that same
 * config prompt read client-side.
 */
export const pushAndExitDelivery: TurnDelivery = {
  kind: "push-and-exit",
  async send(fetchEndpoint, conversationId, _text, turnId, signal) {
    await fetchEndpoint(
      startPushAndExit,
      { id: conversationId },
      { body: { turnId }, signal },
    );
  },
};
