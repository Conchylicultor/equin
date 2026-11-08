import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mainCheckoutServed } from "./internal/served";

export default {
  description:
    "Where the file explorer's equin place leads, desktop half: serves the file-explorer.main-checkout value, the main checkout's path (needsMachine — a host without the computer has no checkout, and the place is left out).",
  contributions: [...mainCheckoutServed.declare],
} satisfies MachinePluginDefinition;
