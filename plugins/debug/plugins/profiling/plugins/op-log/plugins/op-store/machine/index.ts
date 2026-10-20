import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { opsHistoryServed, opsInFlightServed } from "./internal/resources";

export default {
  description:
    "The op-store live collections, desktop-only half: opsInFlight and opsHistory over the op_log_ops rows ingested from this machine's op log, so a host without the computer answers them unavailable.",
  contributions: [...opsInFlightServed.declare, ...opsHistoryServed.declare],
} satisfies MachinePluginDefinition;
