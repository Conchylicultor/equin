import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { turnIdKind } from "@plugins/conversations/plugins/turn-ledger/core";

export const startPushAndExit = defineEndpoint({
  route: "POST /api/conversations/:id/push-and-exit",
  // `turnId`: the client's ledger id for the wrap-up turn (a repeated request
  // is a no-op); minted by the server when absent.
  body: z.object({ turnId: turnIdKind.schema.optional() }),
  response: z.object({ turnId: z.string() }),
});
