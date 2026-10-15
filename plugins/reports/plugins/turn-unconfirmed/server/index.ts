import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  TurnUnconfirmedPayloadSchema,
  turnUnconfirmedFingerprint,
} from "../core";
import {
  renderTurnUnconfirmedTask,
  TURN_UNCONFIRMED_NOTIF_COOLDOWN_MS,
} from "./internal/turn-unconfirmed-task";

export default {
  description:
    "Retired turn-unconfirmed report kind, kept registered so existing rows still validate, render and can be investigated (an investigated report is never swept): a sent turn the browser's old pending-turn store never found in the transcript within 90 s. Nothing files it any more — the turn ledger's turn-merged / turn-unverified / turn-input-not-empty kinds (conversations/turn-ledger) replace it. Fingerprints by conversation id; re-arms every 6h.",
  contributions: [
    ReportKind({
      kind: "turn-unconfirmed",
      schema: TurnUnconfirmedPayloadSchema,
      fingerprint: turnUnconfirmedFingerprint,
      meta: {
        tag: "[turn-unconfirmed]",
        notif: "Turn not confirmed in transcript",
        variant: "warning",
        notifCooldownMs: TURN_UNCONFIRMED_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderTurnUnconfirmedTask,
    }),
  ],
} satisfies ServerPluginDefinition;
