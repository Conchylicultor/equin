import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { MAX_CLIENT_SLOW_OP_ITEMS } from "../../core";
import {
  submitClientSlowOp,
  type SlowOpClientItem,
} from "../../shared/endpoints";

// The browser-side queue behind the client slow-op signals (page-load,
// element-settle, and the client latency signals). The collector used to POST once per slow element, so a boot
// wave that re-settled 200 resources sent 200 requests — each a DB transaction
// plus a report upsert — against the backend that was already the thing
// failing. Queueing collapses that burst into one request per ~250 ms.
//
// Shaped after `plugins/primitives/plugins/log-channels/web/client-log.ts`: a
// module-level buffer, ONE trailing debounce timer, a hard cap that drops the
// oldest while carrying the drop count forward, and chunked `keepalive` POSTs
// bounded by the server-side max. It carries none of clientLog's retry/backoff
// machinery on purpose — this is a `report: false` fire-and-forget beacon, and
// a failed batch is dropped exactly as a failed single POST was before.
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
        // Passive telemetry: a failed beacon must never toast or recurse into
        // the report path. It still rejects — the failure is loud as an
        // unhandled rejection, exactly as the per-element POST it replaces.
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
