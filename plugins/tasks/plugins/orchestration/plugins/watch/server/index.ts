import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { watchEventIdKind, watchIdKind } from "../core";
import { watchStopWaiver } from "./internal/waiver";

export { WatchHandler } from "./internal/contributions";
export type {
  WatchHandlerCtx,
  WatchHandlerEntry,
} from "./internal/contributions";
export {
  endWatch,
  retargetWatch,
  watchesOf,
  watchTask,
} from "./internal/queries";
export type { WatchRow } from "./internal/queries";

export default {
  portable: true,
  description:
    "Watch, every host's half: task_watches (who watches which task's subtree; live while not ended and its conversation not done) and watch_inbox (routed, not yet delivered events), with their id kinds; watchTask / endWatch / retargetWatch / watchesOf; the WatchSource and WatchHandler contribution kinds; the routing, quiet and delivery policy over the tables; and the stop waiver (a watcher whose subtree still has work running may stop — the next event wakes it). Names no source, handler or workflow.",
  contributions: [
    IdKinds.Kind({ kind: watchIdKind }),
    IdKinds.Kind({ kind: watchEventIdKind }),
    watchStopWaiver,
  ],
} satisfies ServerPluginDefinition;
