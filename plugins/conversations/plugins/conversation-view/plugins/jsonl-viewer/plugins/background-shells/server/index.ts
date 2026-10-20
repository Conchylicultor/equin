import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  shellOutputServed,
  shellOutputWatcher,
} from "./internal/output-resource";
import { factsServed } from "./internal/served";

export default {
  description:
    "Serves the live tail of one background shell's output file: resolves the file from the conversation's own transcript (never from the browser), checks its shape, reads its last 64 KB per change, and watches it with a per-write (kqueue) file watcher while subscribed.",
  register: [shellOutputWatcher],
  contributions: [...shellOutputServed.declare, ...factsServed.declare],
} satisfies ServerPluginDefinition;
