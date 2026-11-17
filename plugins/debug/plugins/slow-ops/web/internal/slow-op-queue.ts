import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import {
  pausesDuring,
  stallsKnownThrough,
} from "@plugins/primitives/plugins/perfs/plugins/page-pauses/web";
import { AUTOMATED_BROWSER } from "@plugins/primitives/plugins/scope/plugins/automation/web";
import { MAX_CLIENT_SLOW_OP_ITEMS } from "../../core";
import {
  submitClientSlowOp,
  type SlowOpClientItem,
} from "../../shared/endpoints";
import { judgePagePauses, type SpanWindow } from "./page-pause-judge";

// Page-wide telemetry: slow-op samples always reach the page's own server (D3).
const fetchEndpoint = fetchEndpointOver(pageTransport);

// The browser-side queue behind the client slow-op signals (page-load,
// element-settle, and the client latency signals). The collector used to POST once per slow element, so a boot
// wave that re-settled 200 resources sent 200 requests — each a DB transaction
// plus a report upsert — against the backend that was already the thing
// failing. Queueing collapses that burst into one request per ~250 ms.
//
// Shaped after `plugins/primitives/plugins/log-channels/web/client-log.ts`: a
// module-level buffer, ONE trailing debounce timer, a hard cap that drops the
// oldest while carrying the drop count forward, and chunked `keepalive` POSTs
// bounded by the server-side max. It is a `report: false` beacon: a batch is
// retried across a backend restart (SLOW_OP_RETRY), and a batch that still
// fails after that is dropped, loudly.
//
// One rule rides the flush: an item queued with its wall-clock window is
// judged against the page's pauses inside it (`judgePagePauses`) — the time the
// tab was hidden and its main-thread stalls taken off its own time — once the
// page's stall record is known to hold every long frame inside it
// (`stallsKnownThrough`: a long frame's entry is delivered after the frame,
// late on a busy page). Nothing else is filtered here. See "Own time" in ../../CLAUDE.md.

interface Queued {
  item: SlowOpClientItem;
  /** Where it sat on the wall clock; absent ⇒ not subject to page pauses. */
  window?: SpanWindow;
}

const queue: Queued[] = [];
const FLUSH_DELAY_MS = 250;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue cap. Unbounded, a tab stuck against a dead backend would grow browser
 * memory without limit — and one-instance-per-user means that is the same host
 * already in trouble.
 */
const MAX_QUEUED = 1_000;

/**
 * Items discarded by the cap since the last batch went out. Rides the next
 * batch's `dropped` field so the server records the loss instead of the loss
 * being silent — the counter half of clientLog's drop marker line.
 */
let dropped = 0;

/**
 * Retry budget for one batch — the reports beacon's (`reports/web/report.ts`):
 * 6 retries sleeping 0.5 … 16 s, about 31.5 s, enough to outlast a backend hot
 * restart (main restarts on every push). Only a network error or a 502/503/504
 * is retried. A response lost after the server recorded the batch would count
 * it twice; for slow-op counters that is an accepted overcount, unlike a
 * `Failed to fetch` crash report on every restart.
 */
const SLOW_OP_RETRY = { retries: 6, backoffMs: 500 };

/**
 * The largest batch body sent with `keepalive`: under Chrome's 64 KB budget
 * for every keepalive body in flight, with room for the page's other beacons
 * (client logs, reports).
 */
const KEEPALIVE_BODY_MAX = 24_000;

/**
 * Queue one item. With `window`, the item is judged against the page's pauses
 * inside it at the flush (and stamped `endedAt` = its end, so the server can
 * place it — and take any machine sleep off it).
 */
export function enqueueSlowOp(
  item: SlowOpClientItem,
  window?: SpanWindow,
): void {
  queue.push(window === undefined ? { item } : { item, window });
  capQueue();
  scheduleFlush();
}

/**
 * Enforce the cap by discarding the OLDEST items — the same choice clientLog
 * makes, and for the same reason: the newest signals describe the stall the
 * user is living through right now. The loss is accounted for in `dropped`.
 */
function capQueue(): void {
  if (queue.length <= MAX_QUEUED) return;
  dropped += queue.splice(0, queue.length - MAX_QUEUED).length;
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  // Single trailing debounce timer — not a poll loop. Cleared once it fires.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

/**
 * The next chunk to send: items with no window, and windowed items ending by
 * `knownThrough` (the page's stall record is complete for them), oldest first.
 * `null`: no wait was made — no windowed item was queued, or the page is
 * departing and judges with what it knows — so every item is taken.
 */
function takeReady(knownThrough: number | null): Queued[] {
  const ready: Queued[] = [];
  for (
    let i = 0;
    i < queue.length && ready.length < MAX_CLIENT_SLOW_OP_ITEMS;
  ) {
    const q = queue[i]!;
    if (
      knownThrough === null ||
      q.window === undefined ||
      q.window.endMs <= knownThrough
    ) {
      ready.push(q);
      queue.splice(i, 1);
    } else i++;
  }
  return ready;
}

function latestWindowEnd(): number | null {
  let latest: number | null = null;
  for (const { window } of queue)
    if (window !== undefined && (latest === null || window.endMs > latest))
      latest = window.endMs;
  return latest;
}

async function flush(departing = false): Promise<void> {
  while (queue.length > 0) {
    // A windowed item is judged only once the page's stall record holds every
    // long frame that ended inside it (`stallsKnownThrough`): the entry of the
    // stall an update or settle sat behind reaches the page after the frame,
    // late on a page still busy from it, and judged before it the stall was
    // filed again as each item's own time. Items queued meanwhile, ending
    // later, wait for the next pass of this loop.
    const knownThrough = departing ? null : latestWindowEnd();
    if (knownThrough !== null) await stallsKnownThrough(knownThrough);
    // Drain in chunks the server will accept (≤ MAX_CLIENT_SLOW_OP_ITEMS). An
    // over-cap POST would be rejected with 400, so the chunk size — not the
    // accumulated queue length — bounds each request.
    const items = takeReady(knownThrough).flatMap(({ item, window }) => {
      if (window === undefined) return [item];
      const judged = judgePagePauses(
        item,
        pausesDuring(window.startMs, window.endMs),
      );
      return judged === null ? [] : [{ ...judged, endedAt: window.endMs }];
    });
    if (items.length === 0) continue;
    const carried = dropped;
    const body = {
      items,
      ...(carried > 0 ? { dropped: carried } : {}),
      // A browser under automation (the agent browser, an e2e run) runs the
      // code a visitor does, so its signals are recorded and reported like
      // any other — only marked, so a report says who saw it.
      ...(AUTOMATED_BROWSER ? { automated: true } : {}),
    };
    await fetchEndpoint(
      submitClientSlowOp,
      {},
      {
        body,
        // Chrome refuses a keepalive request once the keepalive bodies in
        // flight pass 64 KB (a TypeError, retried in vain): a batch carrying a
        // long frame's sampled stacks (`evidence`, up to ~40 KB) can. Such a
        // batch goes as a plain request — lost only if the page unloads under it.
        keepalive: JSON.stringify(body).length <= KEEPALIVE_BODY_MAX,
        retry: SLOW_OP_RETRY,
        // Passive telemetry: a failed beacon must never toast or recurse into
        // the report path. Once the retries run out it still rejects — a
        // backend down past the budget is loud as an unhandled rejection.
        report: false,
      },
    );
    // Only reached when the batch landed. On a throw the tally is untouched and
    // rides the next batch instead of vanishing with the failed request.
    dropped -= carried;
  }
}

// Flush on tab departure so a queued signal isn't lost to the debounce window
// when the page goes away. `keepalive` is what lets the request survive the
// unload; this is the trigger that starts it in time.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // No wait for the stall record: the page is going, and `keepalive` only
    // carries a request started in this handler.
    void flush(true);
  });
}
