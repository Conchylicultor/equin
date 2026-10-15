import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "turn-send-safety/no-adhoc-turn-send",
    paths: ["web/internal/delivery.ts"],
    kind: "sanctioned",
    reason:
      "The answer's TurnDelivery — with pending-turn's and push-and-exit's delivery modules, the ONLY web modules allowed to call a turn endpoint. sendConversationTurn runs it, so the ledger row is never bypassed.",
  },
] satisfies Exemptions;
