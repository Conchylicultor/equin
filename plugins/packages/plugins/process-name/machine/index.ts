import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  CHECKOUT_BUN_DIR,
  checkoutBun,
  linkNamedBinary,
  processName,
  refreshCheckoutBun,
} from "./internal/process-name";
export type { NamedBinary } from "./internal/process-name";

export default {
  description:
    "What a process is called in Activity Monitor and ps: processName(kind, id?) spells `equin · <kind> · <id>`, and linkNamedBinary hardlinks an executable under that name (same signed file, swapped in with one rename) — macOS names a process by the file it executed, and process.title changes nothing. Also the checkout's Bun record (refreshCheckoutBun / checkoutBun) the `./equin` script and the build name CLI ops and backends from.",
} satisfies MachinePluginDefinition;
