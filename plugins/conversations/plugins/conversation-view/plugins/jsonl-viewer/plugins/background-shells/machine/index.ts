import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  shellOutputServed,
  shellOutputWatcher,
} from "./internal/output-resource";

export default {
  description:
    "Background shells, desktop-only half: the live tail of one shell's output file — resolved from the conversation's own transcript (never from the browser), its shape checked, its last 64 KB read per change and watched with a per-write (kqueue) file watcher while subscribed — so a host without the computer answers it unavailable.",
  register: [shellOutputWatcher],
  contributions: [...shellOutputServed.declare],
} satisfies MachinePluginDefinition;
