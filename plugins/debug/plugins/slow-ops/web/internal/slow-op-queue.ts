import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { MAX_CLIENT_SLOW_OP_ITEMS } from "../../core";
import {
  submitClientSlowOp,
  type SlowOpClientItem,
} from "../../shared/endpoints";

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
// This queue is TRANSPORT ONLY. It never filters, thresholds or suppresses a
// signal: every slow settle the collector observes still reaches recordSlowOp
// with the same attribution. See the "Cold-start slowness is UX truth" section
// of ../../CLAUDE.md.

const queue: SlowOpClientItem[] = [];
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

export function enqueueSlowOp(item: SlowOpClientItem): void {
  queue.push(item);
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

async function flush(): Promise<void> {
  while (queue.length > 0) {
    // Drain in chunks the server will accept (≤ MAX_CLIENT_SLOW_OP_ITEMS). An
    // over-cap POST would be rejected with 400, so the chunk size — not the
    // accumulated queue length — bounds each request.
    const items = queue.splice(0, MAX_CLIENT_SLOW_OP_ITEMS);
    const carried = dropped;
    await fetchEndpoint(
      submitClientSlowOp,
      {},
      {
        body: { items, ...(carried > 0 ? { dropped: carried } : {}) },
        keepalive: true,
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
    void flush();
  });
}
