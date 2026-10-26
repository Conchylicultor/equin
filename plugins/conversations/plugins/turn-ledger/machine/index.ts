import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { turnUnverifiedKind } from "./internal/report-kinds";
import { conversationTurnsRetention } from "./internal/retention";

export default {
  description:
    "The turn ledger, desktop-only half: the 7-day retention sweep of settled rows, and the retired turn-unverified report kind (nothing files it; kept registered while old rows remain).",
  register: [conversationTurnsRetention],
  contributions: [turnUnverifiedKind],
} satisfies MachinePluginDefinition;
