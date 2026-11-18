import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pinDecisionSource } from "./internal/decisions";
import { pinDriftReaction } from "./internal/reaction";
import { pinDriftServed, pinnedDepsWatcher } from "./internal/served";

export default {
  description:
    "Pinned-dependency drift, desktop half: serves the deps.pin-drift push value — every dependency declaring a pin (infra/deps pinStatus: the pinned install, the one the live daemon runs when another, and what main's checkout declares, with the pin's switchBlocked verdict) — re-read when main advances and when the pinned dependencies' cache dirs or review records change. needsMachine. Also the Dependency upgrades automation's pinned-binaries decision source: a pin lagging main past PIN_LAG_MAX_DAYS (30) with no stay in force, or whose stay's reviewBy passed, is carried by the weekly upgrade task for a person to decide (switch, or stay with a reason, at most 90 days).",
  register: [pinDriftReaction, pinnedDepsWatcher],
  contributions: [...pinDriftServed.declare, pinDecisionSource],
} satisfies MachinePluginDefinition;
