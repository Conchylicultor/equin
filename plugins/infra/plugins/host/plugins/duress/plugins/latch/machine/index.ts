import {
  reportServerError,
  sinkHandler,
  type MachinePluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { duressLatchFaultSink } from "../server";

export default {
  description:
    "The latch's desktop half: files the latch's own failures (its watch failing to open or breaking, an unreadable latch) as server errors (scope duress-latch). Kept out of the latch's server barrel, which the CLI and the sentinel worker thread import and so may not reach server-core.",
  sinkHandlers: [
    sinkHandler(duressLatchFaultSink, () => (fault) => {
      reportServerError({
        ...fault,
        scope:
          fault.scope === null
            ? "duress-latch"
            : `duress-latch › ${fault.scope}`,
      });
    }),
  ],
} satisfies MachinePluginDefinition;
