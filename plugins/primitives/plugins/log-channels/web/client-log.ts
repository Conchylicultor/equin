import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { subscribeWsStatus } from "@plugins/primitives/plugins/networking/web";
import { emitLogs, MAX_EMIT_LINES } from "../core";

// Page-wide telemetry: persisted client logs always reach the page's own server (D3).
const fetchEndpoint = fetchEndpointOver(pageTransport);

// Browser console.log-style logging that persists to a per-worktree JSONL file
// the agent can read with `tail`/`cat` — no browser/Playwright needed. Lines are
// buffered per channel and flushed (debounced) to POST /api/logs/emit, which
// appends them to the per-worktree logs directory (see persist.ts / logs CLAUDE.md).
//
// Flush invariants (every trigger goes through `requestFlush`):
// - Single-flight: at most one flush runs; a trigger during it re-runs it once after.
// - Hold after failure: a rejected POST sets a hold whose one timer is the ONLY
//   thing that flushes next — 5 s after a plain failure, 30 s after a `paused`
//   answer. The debounce and WS-`open` triggers are no-ops meanwhile, except that
//   an `open` lifts a plain-failure hold (the backend is back); it never lifts a
//   `paused` hold.
// - No polling: timers exist only for the debounce and on a failure edge.

type LogStream = "stdout" | "stderr";
interface BufferedLine {
  line: string;
  stream?: LogStream;
  t: number;
  /**
   * Set ONLY on the synthetic drop marker, carrying how many real lines it stands
   * for. Lets a later drop that swallows the marker fold its count forward instead
   * of restarting the tally, and keeps the marker out of the wire shape (see
   * `toWire`).
   */
  dropped?: number;
}

const buffer = new Map<string, BufferedLine[]>();
const FLUSH_DELAY_MS = 250;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Per-channel buffer cap. The buffer used to be unbounded, so a long backend
 * outage (or a duress episode, during which the server answers `paused`) plus a chatty
 * tab grew browser memory without limit — and one-instance-per-user means that is
 * the same host that is already in trouble.
 */
const MAX_BUFFERED_LINES = 4_000;

/** Backoff after a failed flush, and the longer one the server's `paused` asks for. */
const RETRY_DELAY_MS = 5_000;
const BACKPRESSURE_RETRY_DELAY_MS = 30_000;

export function clientLog(
  channel: string,
  line: string,
  stream?: LogStream,
): void {
  let lines = buffer.get(channel);
  if (!lines) {
    lines = [];
    buffer.set(channel, lines);
  }
  lines.push({ line, stream, t: Date.now() });
  capBuffer(lines);
  scheduleFlush();
}

/**
 * Enforce the cap by dropping the OLDEST lines — deliberately the opposite of the
 * server-side duress shed buffer's drop-newest. That buffer can afford to keep the
 * head because it has a first-N-durable guarantee at episode onset; the browser has
 * no such thing, and its newest lines describe the problem the user is looking at
 * right now. The loss is never silent: one marker line takes the head slot (which is
 * why the reserve below is `MAX_BUFFERED_LINES - 1`), and a marker swallowed by a
 * later drop hands its own count forward, so the tally is cumulative.
 */
function capBuffer(lines: BufferedLine[]): void {
  if (lines.length <= MAX_BUFFERED_LINES) return;
  const removed = lines.splice(0, lines.length - (MAX_BUFFERED_LINES - 1));
  let dropped = 0;
  for (const r of removed) dropped += r.dropped ?? 1;
  lines.unshift({
    line: `[clientLog] dropped ${dropped} lines under backpressure`,
    stream: "stderr",
    t: Date.now(),
    dropped,
  });
}

/** The emit wire shape — drops the marker's internal `dropped` bookkeeping. */
function toWire(l: BufferedLine): {
  line: string;
  stream?: LogStream;
  t: number;
} {
  return { line: l.line, stream: l.stream, t: l.t };
}

function scheduleFlush(): void {
  // During a hold nothing but the retry timer may flush, so there is nothing to
  // debounce — and no reason to arm a timer at all.
  if (flushTimer !== null || hold !== null) return;
  // Single trailing debounce timer — not a poll loop. Cleared once it fires.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    requestFlush("debounce");
  }, FLUSH_DELAY_MS);
}

/**
 * Why the last flush failed, which decides how a WS reconnect treats the hold:
 * - `failure`: the backend refused or was unreachable (mid-restart, the
 *   `./singularity build` case). A reconnect proves it is back, so it lifts the hold.
 * - `backpressure`: the server answered `paused` because the host-global duress
 *   latch is set. A reconnect says nothing about the latch, so only the timer lifts it.
 */
type HoldKind = "failure" | "backpressure";

/**
 * The hold after a failed flush. The kind and its ONE retry timer live in one value,
 * so "held" and "a retry is armed" cannot disagree: while `hold` is set, the timer is
 * the only thing that flushes (the debounce and a WS `open` are no-ops, except that an
 * `open` lifts a `failure` hold), and the timer's firing is what clears it.
 *
 * The timer sits on a FAILURE EDGE, not a poll loop: nothing is ever scheduled while
 * flushes succeed, and it clears itself the moment it fires. It exists because the
 * other two triggers are events that may never come — a later `clientLog` call and a
 * WS reconnect — so a tab that goes quiet right after a rejection would otherwise
 * strand its buffered lines until the next page load.
 */
let hold: { kind: HoldKind; timer: ReturnType<typeof setTimeout> } | null =
  null;

function setHold(kind: HoldKind): void {
  // Only a flush sets a hold, and a flush only runs with none in place (see
  // `requestFlush`) — so a live hold here is a broken invariant, not a merge case.
  if (hold !== null) throw new Error("[clientLog] hold set twice");
  const delayMs =
    kind === "backpressure" ? BACKPRESSURE_RETRY_DELAY_MS : RETRY_DELAY_MS;
  hold = {
    kind,
    timer: setTimeout(() => {
      hold = null;
      requestFlush("retry");
    }, delayMs),
  };
}

function clearHold(): void {
  if (hold === null) return;
  clearTimeout(hold.timer);
  hold = null;
}

/**
 * Single-flight state. At most one flush runs at a time; a request arriving while
 * one runs marks it `dirty`, and the running flush goes round once more when it
 * finishes. So batches never interleave, a failed batch's re-queue can only land
 * ahead of lines that are genuinely newer, and N concurrent triggers cost one POST
 * stream, not N.
 */
let running = false;
let dirty = false;

type FlushTrigger = "debounce" | "ws-open" | "retry";

/** The one entry point to a flush — every trigger goes through the hold gate here. */
function requestFlush(trigger: FlushTrigger): void {
  if (trigger === "ws-open" && hold?.kind === "failure") clearHold();
  // The retry timer clears the hold before calling in, so a remaining hold means
  // this is a debounce / WS trigger arriving during a backoff: drop it.
  if (hold !== null) return;
  if (running) {
    dirty = true;
    return;
  }
  void runFlush();
}

async function runFlush(): Promise<void> {
  running = true;
  try {
    do {
      dirty = false;
      const failed = await drainBuffer();
      if (failed !== null) {
        // The retry timer now owns the next attempt; a `dirty` set meanwhile is
        // folded into it (the retry drains everything buffered by then).
        setHold(failed);
        break;
      }
    } while (dirty);
  } finally {
    running = false;
    dirty = false;
  }
}

/**
 * One pass over every channel. Stops at the FIRST rejected batch — a `paused` or an
 * unreachable backend will refuse the next channel's POST just the same, and each
 * refused POST is exactly the traffic the rejection asked us to shed.
 */
async function drainBuffer(): Promise<HoldKind | null> {
  for (const [channel, lines] of buffer) {
    // Drain this channel in batches the server will accept (≤ MAX_EMIT_LINES).
    // A single over-cap POST would be rejected with 400 on every retry forever,
    // so the chunk size — not the accumulated buffer length — bounds each request.
    while (lines.length > 0) {
      const drained = lines.splice(0, MAX_EMIT_LINES);
      let refused: HoldKind | null = null;
      try {
        const result = await fetchEndpoint(
          emitLogs,
          {},
          { body: { channel, lines: drained.map(toWire) } },
        );
        // `paused` is the server saying "stop, the box is on fire" — back off far
        // harder than for a plain restart, which resolves in seconds.
        if (result.status === "paused") refused = "backpressure";
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        // Surface the failure for visibility; the hold's timer retries.
        console.debug("[clientLog] flush failed, will retry:", err.message);
        refused = "failure";
      }
      if (refused !== null) {
        // Deliberate, self-correcting re-queue: the backend may be mid-restart
        // or pausing ingress while the host is under duress. Put the lines back
        // ahead of anything newly buffered — single-flight guarantees nothing
        // older is in flight — and re-apply the cap, since the buffer kept growing
        // while this batch was out.
        lines.unshift(...drained);
        capBuffer(lines);
        return refused;
      }
    }
  }
  return null;
}

// Reconnect flush: when the worktree WS channel comes back up after the backend
// restart, drain anything buffered during the downtime. Several sockets publish on
// this global bus (via SharedWebSocket), so this fires often — the hold gate and
// single-flight in `requestFlush` are what keep it from multiplying POSTs.
subscribeWsStatus((ev) => {
  if (ev.status === "open") requestFlush("ws-open");
});
