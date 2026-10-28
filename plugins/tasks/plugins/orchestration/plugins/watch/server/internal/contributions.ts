import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { DbExecutor } from "@plugins/database/server";
import type { WatchEvent, WatchEventInput } from "../../core";
import type { WatchRow } from "./queries";

/**
 * Turns one emitted fact into the events a watcher hears. Contributed by the
 * plugin that owns the fact, always through {@link watchSource} — which pairs
 * it with the trigger that feeds it, so a source cannot exist unfed.
 */
export interface WatchSourceEntry {
  id: string;
  toEvents: (
    payload: Record<string, unknown>,
  ) => WatchEventInput[] | Promise<WatchEventInput[]>;
}

export const WatchSource = defineServerContribution<WatchSourceEntry>(
  "watchSource",
  { docLabel: (s) => s.id },
);

/** The context a code watcher's batch arrives with. */
export interface WatchHandlerCtx {
  /** The watch the batch was routed to (its `watcher.key` names the owner). */
  watch: WatchRow;
  /** The delivery's transaction: the batch's rows are claimed on it, and a
   * throw rolls the claim back (the job retries the same batch). */
  tx: DbExecutor;
}

/** A code watcher: called with every batch delivered to a watch whose
 * watcher is `{ kind: "code", handler: id }`. */
export interface WatchHandlerEntry {
  id: string;
  onEvents: (batch: WatchEvent[], ctx: WatchHandlerCtx) => Promise<void>;
}

export const WatchHandler = defineServerContribution<WatchHandlerEntry>(
  "watchHandler",
  { docLabel: (h) => h.id },
);

function uniqueById<T extends { id: string }>(
  what: string,
  entries: readonly T[],
): Map<string, T> {
  const byId = new Map<string, T>();
  for (const e of entries) {
    if (byId.has(e.id))
      throw new Error(`${what} "${e.id}" is contributed twice`);
    byId.set(e.id, e);
  }
  return byId;
}

export function watchSourceById(id: string): WatchSourceEntry | undefined {
  return uniqueById("WatchSource", WatchSource.getContributions()).get(id);
}

export function watchHandlerById(id: string): WatchHandlerEntry | undefined {
  return uniqueById("WatchHandler", WatchHandler.getContributions()).get(id);
}
