import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  CHECKOUT_BUN_DIR,
  checkoutBun,
  cloneNamedBinary,
  processName,
  refreshCheckoutBun,
} from "./internal/process-name";
export type { NamedBinary } from "./internal/process-name";

export default {
  description:
    "What a process is called in Activity Monitor and ps: processName(kind, id?) spells `equin · <kind> · <id>`, and cloneNamedBinary gives an executable that name as an APFS clone (same signed bytes, no disk cost, a file of its own — never a hardlink, whose many names let macOS's exec scan be handed a deleted one and SIGKILL the process — left alone while current, else swapped in with one rename) — macOS names a process by the file it executed, and process.title changes nothing. Also the checkout's Bun record (refreshCheckoutBun / checkoutBun) the `./equin` script and the build name CLI ops and backends from.",
} satisfies MachinePluginDefinition;
