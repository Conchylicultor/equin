import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  currentSleepReading,
  onSleepReadingChanged,
  publishSleepReading,
} from "./internal/publish";

export default {
  description:
    "The machine's sleep clock, read and published: publishSleepReading() re-reads it and tells its listeners only when it changed — called by an existing periodic observer, so a wake reaches the browser without a poller of its own — with currentSleepReading() and onSleepReadingChanged() for the machine half that serves it as the machine.sleep live value.",
} satisfies ServerPluginDefinition;
