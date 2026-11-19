import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { scoreboardServed } from "./internal/served";

export default {
  description:
    "The responsiveness scoreboard's loader, desktop-only: the stats.scoreboard value over the latency ledger's day rollups, the report history, this backend's boot log and main's fix commits (git), so a host without the computer answers it unavailable.",
  contributions: [...scoreboardServed.declare],
} satisfies MachinePluginDefinition;
