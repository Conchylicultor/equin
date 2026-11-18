import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pinDriftReaction } from "./internal/reaction";
import { pinDriftServed, pinnedDepsWatcher } from "./internal/served";

export default {
  description:
    "Pinned-dependency drift, desktop half: serves the deps.pin-drift push value — every dependency declaring a pin (infra/deps pinStatus: the pinned install, the one the live daemon runs when another, and what main's checkout declares, with the pin's switchBlocked verdict) — re-read when main advances and when the pinned dependencies' cache dirs change. needsMachine.",
  register: [pinDriftReaction, pinnedDepsWatcher],
  contributions: [...pinDriftServed.declare],
} satisfies MachinePluginDefinition;
