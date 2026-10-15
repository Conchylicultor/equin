import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "turn-send-safety/no-adhoc-turn-send",
    paths: ["web/internal/delivery.ts"],
    kind: "sanctioned",
    reason:
      "Push & Close's TurnDelivery — with pending-turn's and ask-user-question's delivery modules, the ONLY web modules allowed to call a turn endpoint. sendConversationTurn runs it, so the echo and the ledger row are never bypassed.",
  },
] satisfies Exemptions;
