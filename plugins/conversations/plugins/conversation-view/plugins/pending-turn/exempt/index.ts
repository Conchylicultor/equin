import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "turn-send-safety/no-adhoc-turn-send",
    paths: ["web/internal/delivery.ts"],
    kind: "sanctioned",
    reason:
      "The default delivery and the server's Retry / Copy to draft calls — with push-and-exit's and ask-user-question's delivery modules, the ONLY web modules allowed to call a turn endpoint. Each builds a TurnDelivery that sendConversationTurn runs, so the echo and the ledger row are never bypassed.",
  },
] satisfies Exemptions;
