import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineSleepServed } from "./internal/served";

export default {
  description:
    "Serves the machine.sleep live value (this box's sleep clock: boot, cumulative asleepMs, last wake), desktop-only: a host without the computer answers it unavailable.",
  contributions: [...machineSleepServed.declare],
} satisfies MachinePluginDefinition;
