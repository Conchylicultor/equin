// Await a server write on a live read the caller does not overlay: resolve once
// the page's live tuple has re-read the write's commit — the same causal
// confirmation `useOptimisticResource` applies to its ops (Rule A, the `ackTx`
// channel, and the snapshot-watermark floor), as a promise.

import type { QueryCache } from "@tanstack/react-query";
import {
  ensureNotificationsClient,
  queryKeyFor,
  ResourceError,
  type LiveRegistries,
} from "@plugins/primitives/plugins/live-state/web";
import { compareTxWatermark } from "@plugins/primitives/plugins/live-state/core";
import type { LiveValue } from "@plugins/network/plugins/live/core";
import { resolveOptimisticSource } from "./source";

/** The pipeline a wait listens on — the page's own, or a test's. */
export interface AwaitWritePipeline {
  registries: LiveRegistries;
  queryCache: QueryCache;
}

/**
 * Resolve once the page's live read of `value` (at `params`) has re-read the
 * write whose ack token is `watermark` — so a caller that wrote can act on the
 * result (select a saved theme, report a row gone) without a frame where the
 * read disagrees.
 *
 * Confirmed when a frame for the tuple named the commit in its `ackTx` (the
 * change feed's recompute), or a frame's snapshot watermark is strictly past
 * it (a resubscribe after a reconnect). A write that leaves the read unchanged
 * confirms only if some mounted reader of the tuple asks for standalone ack
 * frames (`useResourceAcks`) — the caller's read must.
 *
 * Rejects with the read's `ResourceError` when the tuple's query is (or turns)
 * failed before the write is confirmed: a read that cannot recompute will
 * never confirm, and the caller reports that rather than hanging. Push-based:
 * it listens to the ack registry and the query cache, never polls. It does not
 * subscribe the tuple — the caller's mounted read does.
 */
export function awaitResourceWrite<Data>(
  value: LiveValue<Data, Record<string, never>>,
  watermark: string,
): Promise<void>;
export function awaitResourceWrite<Data, P extends Record<string, string>>(
  value: LiveValue<Data, P>,
  params: P,
  watermark: string,
): Promise<void>;
export function awaitResourceWrite(
  value: object,
  second: Record<string, string> | string,
  third?: string,
): Promise<void> {
  const client = ensureNotificationsClient();
  const { resource, params } =
    typeof second === "string"
      ? resolveOptimisticSource(value, undefined)
      : resolveOptimisticSource(value, second);
  return awaitWriteOn(
    {
      registries: client.registries,
      queryCache: client.queryClient.getQueryCache(),
    },
    resource.key,
    params,
    typeof second === "string" ? second : third!,
  );
}

/** `awaitResourceWrite` on an explicit pipeline (the testable core). */
export function awaitWriteOn(
  pipeline: AwaitWritePipeline,
  key: string,
  params: Record<string, string> | undefined,
  watermark: string,
): Promise<void> {
  const { txAcks, watermarks } = pipeline.registries;
  const queryKey = queryKeyFor(key, params);
  const reflected = (): boolean => {
    if (txAcks.has(key, params, watermark)) return true;
    const floor = watermarks.get(key, params ?? {});
    return floor !== undefined && compareTxWatermark(floor, watermark) > 0;
  };
  const failure = (): Error | null => {
    const error = pipeline.queryCache.find({ queryKey, exact: true })?.state
      .error;
    if (error === null || error === undefined) return null;
    return error instanceof ResourceError || error instanceof Error
      ? error
      : new Error(`live read ${key} failed: ${String(error)}`);
  };
  if (reflected()) return Promise.resolve();
  const failedNow = failure();
  if (failedNow !== null) return Promise.reject(failedNow);

  return new Promise((resolve, reject) => {
    const stop = () => {
      stopAcks();
      stopCache();
    };
    const check = () => {
      if (reflected()) {
        stop();
        resolve();
        return;
      }
      const failed = failure();
      if (failed !== null) {
        stop();
        reject(failed);
      }
    };
    // A standalone ack frame writes no cache entry; a value frame notes its
    // ackTx / watermark immediately before the cache write it describes.
    const stopAcks = txAcks.subscribe((ackKey) => {
      if (ackKey === key) check();
    });
    const stopCache = pipeline.queryCache.subscribe((event) => {
      if (event.query.queryKey[0] === key) check();
    });
  });
}
