import { compareTxWatermark } from "../core";

// Client-side registry of the newest commit watermark seen per (key, params) —
// the causal floor the optimistic-mutation primitive compares mutation ack
// tokens against (Rules A/B of
// research/2026-07-11-global-never-revert-optimistic-edits.md). Populated by
// `NotificationsClient` from every full frame that carries one (sub-ack /
// update / FULL keyed delta / HTTP body — Rule B′; scoped deltas never do) —
// ALWAYS immediately before the cache write the watermark describes, so a
// QueryCache listener reading the registry synchronously sees the floor of the
// value it was just handed.
//
// One registry per live-state PIPELINE (a NotificationsClient and its
// QueryClient): the page's own pipeline uses `rootWatermarks`, which the free
// functions below read and write — the optimistic hook runs inside QueryCache
// callbacks and jsdom tests exercise the overlay machine without a
// NotificationsProvider, so the root read path must not require a client
// instance. A scoped pipeline (a `<TransportProvider>` subtree talking to
// another backend) gets its own registry, so its tuples never share a causal
// floor with the page's tuples of the same (key, params).
// Monotonic adopt: an older watermark (a joiner-adopted flight, an out-of-order
// HTTP response) never regresses the stored floor.

type ResourceParams = Record<string, string>;

// Canonical params serialization — byte-identical to `paramsKey` in
// notifications-client.ts (sorted-key JSON), so `${key}\0${paramsKey}` here
// names exactly the same subscription id.
function paramsKey(params: ResourceParams | undefined): string {
  if (!params) return "{}";
  const keys = Object.keys(params).sort();
  const obj: ResourceParams = {};
  for (const k of keys) obj[k] = params[k]!;
  return JSON.stringify(obj);
}

function registryId(key: string, params: ResourceParams | undefined): string {
  return `${key}\0${paramsKey(params)}`;
}

export interface WatermarkRegistry {
  note(
    key: string,
    params: ResourceParams | undefined,
    watermark: string,
  ): void;
  get(key: string, params?: ResourceParams): string | undefined;
}

export function createWatermarkRegistry(): WatermarkRegistry {
  const watermarks = new Map<string, string>();
  return {
    note(key, params, watermark) {
      const id = registryId(key, params);
      const prev = watermarks.get(id);
      if (prev !== undefined && compareTxWatermark(watermark, prev) <= 0)
        return;
      watermarks.set(id, watermark);
    },
    get(key, params = {}) {
      return watermarks.get(registryId(key, params));
    },
  };
}

/** The page's own pipeline's registry. */
export const rootWatermarks = createWatermarkRegistry();

/**
 * Adopt a frame's commit watermark for (key, params), monotonically: an equal
 * or older watermark than the stored one is a no-op (compared causally via
 * `compareTxWatermark`, never as strings).
 */
export function noteResourceWatermark(
  key: string,
  params: ResourceParams | undefined,
  watermark: string,
): void {
  rootWatermarks.note(key, params, watermark);
}

/**
 * The newest commit watermark seen for (key, params), or undefined when no
 * watermark-carrying frame has arrived yet (a fresh sub, a central-origin
 * resource — the central runtime has no capture hook, or a pre-watermark
 * server). Undefined means "no causal floor": a consumer may confirm by
 * content but must never deny.
 */
export function getResourceWatermark(
  key: string,
  params: ResourceParams | undefined = {},
): string | undefined {
  return rootWatermarks.get(key, params);
}
