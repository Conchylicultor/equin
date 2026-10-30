import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { turnUnverifiedKind } from "./internal/report-kinds";

export default {
  description:
    "The turn ledger, desktop-only half: the retired turn-unverified report kind (nothing files it; kept registered while old rows remain).",
  contributions: [turnUnverifiedKind],
} satisfies MachinePluginDefinition;
