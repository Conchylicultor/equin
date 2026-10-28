import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { flagWatchSource } from "./internal/watch-source";

export default {
  description:
    "Push-and-exit, desktop-only half: the `flag` watch source — a raised flag (conversation.flagRaised) reaches whoever watches its task as a `flagged` event.",
  contributions: [...flagWatchSource],
} satisfies MachinePluginDefinition;
