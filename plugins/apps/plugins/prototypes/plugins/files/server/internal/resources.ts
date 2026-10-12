import { serveValue } from "@plugins/network/plugins/live/server";
import { prototypesList } from "../../core";
import { listPrototypeMetas } from "./list";

/**
 * `prototypes.list` — re-reads every prototype's `index.html` on each notify.
 * External: the truth is the data dir, and the watcher (`watcher.ts`) notifies
 * when the tree really moved. Each meta's `rev` is what live frames cache-bust
 * on, so a re-broadcast reloads only the prototypes whose files changed.
 */
export const prototypesListServed = serveValue(prototypesList, {
  source: "external",
  changes: "notified",
  loader: async () => listPrototypeMetas(),
});
