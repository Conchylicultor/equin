import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  registerTurnVerdictReports,
  turnMergedKind,
  turnUnverifiedKind,
} from "./internal/report-kinds";
import { conversationTurnsRetention } from "./internal/retention";

export default {
  description:
    "The turn ledger, desktop-only half: the turn-merged / turn-unverified report kinds (filed from the server half's turnVerdictSink) and the 7-day retention sweep of settled rows.",
  register: [conversationTurnsRetention],
  contributions: [turnMergedKind, turnUnverifiedKind],
  onReady() {
    registerTurnVerdictReports();
  },
} satisfies MachinePluginDefinition;
