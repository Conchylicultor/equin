// The router's statement of how long a handler took, on every response it
// answers — as a standard `Server-Timing` header, so the browser records it on
// the request's Resource Timing entry (`serverTiming`) next to its own network
// stamps. A client then splits a request's round trip into the page's wait,
// the network and the server from stamps none of which its own main thread
// takes (`primitives/networking`'s `requestTimingOf`).

/** The metric name this router stamps (`Server-Timing: equin;dur=…;desc=…`). */
export const SERVER_TIMING_METRIC = "equin";

/**
 * What one stamp says: the handler's own time (`handlerMs`: the route handler
 * called → its response returned — headers ready; a streamed body's tail is
 * not in it) and a per-response `id` that names the request's Resource Timing
 * entry exactly (the browser exposes no request id of its own).
 */
export interface ServerTimingStamp {
  readonly handlerMs: number;
  readonly id: string;
}

/** The header value carrying `stamp`. */
export function serverTimingValue(stamp: ServerTimingStamp): string {
  return `${SERVER_TIMING_METRIC};dur=${stamp.handlerMs.toFixed(1)};desc="${stamp.id}"`;
}

// Our own stamp only: a metric entry `equin;dur=<n>;desc="<id>"` among any
// others a proxy may have joined to the header.
const STAMP = new RegExp(
  `(?:^|,)\\s*${SERVER_TIMING_METRIC}\\s*;\\s*dur=([0-9.]+)\\s*;\\s*desc="([^"]+)"`,
);

/**
 * The stamp in a `Server-Timing` header value, or why there is none: the
 * header is absent (a response this router did not answer — the gateway's own
 * 502, an unrouted path) or carries no stamp of ours.
 */
export function readServerTiming(
  header: string | null,
):
  | { readonly kind: "stamped"; readonly stamp: ServerTimingStamp }
  | { readonly kind: "unstamped"; readonly reason: string } {
  if (header === null)
    return { kind: "unstamped", reason: "the response has no Server-Timing" };
  const m = STAMP.exec(header);
  if (!m)
    return {
      kind: "unstamped",
      reason: `the response's Server-Timing has no ${SERVER_TIMING_METRIC} stamp`,
    };
  return { kind: "stamped", stamp: { handlerMs: Number(m[1]), id: m[2]! } };
}
