// Where one request's round trip went, from stamps the page's main thread does
// not take: the browser's Resource Timing entry for it (when the request left,
// when its first and last byte came back — recorded by the network stack) and
// the server's own `Server-Timing` handler time (framework/http-router). A
// `.then` continuation runs only when the main thread is free, so two
// `performance.now()` reads around an `await fetch` measure the page's wait as
// much as the server's (2026-11-04: ~107 ms read as a write's server time, of
// which the handler was 13 ms).
import { readServerTiming } from "@plugins/framework/plugins/http-router/core";
import type { Transport } from "./transport";

/**
 * One request's timing. `measured`: its stamps on this page's
 * `performance.now()` timeline (`requestStart` — the request left the browser,
 * `responseEnd` — its last byte arrived) and the server handler's own time
 * (`serverMs`, a duration on the server's clock, so no skew). `unmeasured`:
 * why the request could not be timed so — a state, never a stand-in zero.
 */
export type RequestTiming =
  | {
      readonly kind: "measured";
      readonly requestStart: number;
      readonly responseEnd: number;
      readonly serverMs: number;
    }
  | { readonly kind: "unmeasured"; readonly reason: string };

/**
 * How long the browser may take to deliver a request's Resource Timing entry
 * after its response arrived. A bound around the browser's own queue (the
 * entry is handed to observers as a task of its own, after the frame the
 * response landed in), not a timeout on our code.
 */
export const RESOURCE_TIMING_WAIT_MS = 10_000;

interface Waiter {
  resolve(entry: PerformanceResourceTiming): void;
}

/** Stamp id → who waits for its entry. One observer for the page. */
const waiters = new Map<string, Waiter>();
let observer: PerformanceObserver | null = null;

function stampIdOf(entry: PerformanceResourceTiming): string | undefined {
  // `serverTiming` lists the response's Server-Timing metrics.
  for (const metric of entry.serverTiming)
    if (waiters.has(metric.description)) return metric.description;
  return undefined;
}

function deliver(entries: readonly PerformanceEntry[]): void {
  for (const entry of entries) {
    const timing = entry as PerformanceResourceTiming;
    const id = stampIdOf(timing);
    if (id === undefined) continue;
    const waiter = waiters.get(id)!;
    waiters.delete(id);
    waiter.resolve(timing);
  }
}

function ensureObserver(): void {
  if (observer) return;
  // An observer, not `getEntriesByType`: the performance buffer stops
  // recording at its size limit (250 by default); observers still get every
  // entry.
  observer = new PerformanceObserver((list) => deliver(list.getEntries()));
  observer.observe({ type: "resource" });
}

function awaitEntry(
  id: string,
): Promise<PerformanceResourceTiming | "timed-out"> {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      waiters.delete(id);
      resolve("timed-out");
    }, RESOURCE_TIMING_WAIT_MS);
    waiters.set(id, {
      resolve(entry) {
        clearTimeout(deadline);
        resolve(entry);
      },
    });
  });
}

/**
 * The timing of the request `res` answers, sent over `transport`. Call it as
 * soon as the response's headers are in (before its body is read), so the
 * entry — recorded at the body's end — is waited for, never missed. Resolves
 * `unmeasured` when the transport's requests are not timed by the browser
 * (`Transport.requestTiming`: an in-page server), the response carries no
 * stamp of the router's (the gateway's own 502), the environment has no
 * Resource Timing, or the entry did not come within
 * `RESOURCE_TIMING_WAIT_MS`.
 */
export async function requestTimingOf(
  res: Response,
  transport: Pick<Transport, "requestTiming">,
): Promise<RequestTiming> {
  if (!transport.requestTiming)
    return {
      kind: "unmeasured",
      reason: "the transport's requests are not network fetches",
    };
  const stamp = readServerTiming(res.headers.get("server-timing"));
  if (stamp.kind === "unstamped")
    return { kind: "unmeasured", reason: stamp.reason };
  if (typeof PerformanceObserver === "undefined")
    return { kind: "unmeasured", reason: "no Resource Timing here" };
  ensureObserver();
  const entry = await awaitEntry(stamp.stamp.id);
  if (entry === "timed-out")
    return {
      kind: "unmeasured",
      reason: `the browser recorded no Resource Timing entry within ${RESOURCE_TIMING_WAIT_MS} ms`,
    };
  // 0 when the browser withheld the detailed stamps (a cross-origin answer
  // without Timing-Allow-Origin) — not a time.
  if (entry.requestStart === 0 || entry.responseEnd === 0)
    return {
      kind: "unmeasured",
      reason: "the Resource Timing entry has no request/response stamps",
    };
  return {
    kind: "measured",
    requestStart: entry.requestStart,
    responseEnd: entry.responseEnd,
    serverMs: stamp.stamp.handlerMs,
  };
}
