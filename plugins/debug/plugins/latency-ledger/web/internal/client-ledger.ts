import {
  EndpointError,
  fetchEndpointOver,
} from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import {
  HISTOGRAM_SCHEME,
  addSample,
  emptyAcc,
  mergeAcc,
  minuteStartOf,
  submitClientLatency,
  type ClientLatencyMetric,
  type ClientMinute,
  type HistogramAcc,
  type Interaction,
} from "../../core";

// Page-wide telemetry: latency samples always reach the page's own server (D3).
const fetchEndpoint = fetchEndpointOver(pageTransport);

// The browser's half of the ledger. Samples are added to a per-minute histogram in
// memory and posted at most once a minute, so a tab receiving hundreds of updates
// a minute costs the server one small request. The server ADDS what it receives,
// which is why a batch is cleared the moment it is handed to the network and put
// back if the request fails: a sample is sent once or kept, never both.

const FLUSH_DELAY_MS = 60_000;
// A page load or a navigation is rare and is what someone watching the card is
// waiting to see: send it within seconds. Update delays arrive by the hundred and
// wait for the minute.
const INTERACTION_FLUSH_DELAY_MS = 5_000;
// A tab cut off from a dead backend must not grow without limit.
const MAX_MINUTES = 60;
const MAX_INTERACTIONS = 100;

const minutes = new Map<
  string,
  { metric: ClientLatencyMetric; minuteStart: number; acc: HistogramAcc }
>();
let interactions: Interaction[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushDueAt = Infinity;

// One-shot, armed only while something is waiting to be sent — not a poll. A
// sooner deadline replaces a later one; a later one never pushes a sooner one back.
function scheduleFlush(delayMs: number): void {
  const dueAt = Date.now() + delayMs;
  if (flushTimer !== null && dueAt >= flushDueAt) return;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushDueAt = dueAt;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDueAt = Infinity;
    void flush();
  }, delayMs);
}

export function recordSample(
  metric: ClientLatencyMetric,
  ms: number,
  flags?: { censored?: boolean; excluded?: boolean },
): void {
  const minuteStart = minuteStartOf(Date.now());
  const id = `${metric}:${minuteStart}`;
  let entry = minutes.get(id);
  if (!entry) {
    if (minutes.size >= MAX_MINUTES) return;
    entry = { metric, minuteStart, acc: emptyAcc() };
    minutes.set(id, entry);
  }
  addSample(entry.acc, ms, flags);
  scheduleFlush(FLUSH_DELAY_MS);
}

export function recordInteraction(interaction: Interaction): void {
  recordSample(interaction.kind, interaction.durationMs, {
    censored: interaction.censored,
    // A hidden tab's timers are throttled: the number says how long the tab sat
    // in the background, not how long the page took.
    excluded: interaction.hidden,
  });
  if (interactions.length < MAX_INTERACTIONS) interactions.push(interaction);
  scheduleFlush(INTERACTION_FLUSH_DELAY_MS);
}

function restore(
  batchMinutes: ClientMinute[],
  batchInteractions: Interaction[],
): void {
  for (const m of batchMinutes) {
    const id = `${m.metric}:${m.minuteStart}`;
    const back: HistogramAcc = {
      counts: m.counts,
      count: m.count,
      sumMs: m.sumMs,
      maxMs: m.maxMs,
      censored: m.censored,
      excluded: m.excluded,
    };
    const existing = minutes.get(id);
    minutes.set(id, {
      metric: m.metric,
      minuteStart: m.minuteStart,
      acc: existing ? mergeAcc(existing.acc, back) : back,
    });
  }
  interactions = [...batchInteractions, ...interactions].slice(
    0,
    MAX_INTERACTIONS,
  );
}

async function flush(): Promise<void> {
  if (minutes.size === 0 && interactions.length === 0) return;
  const batchMinutes: ClientMinute[] = [...minutes.values()].map((e) => ({
    metric: e.metric,
    minuteStart: e.minuteStart,
    ...e.acc,
  }));
  const batchInteractions = interactions;
  minutes.clear();
  interactions = [];
  try {
    await fetchEndpoint(
      submitClientLatency,
      {},
      {
        body: {
          scheme: HISTOGRAM_SCHEME,
          minutes: batchMinutes,
          interactions: batchInteractions,
        },
        keepalive: true,
        // A failed observability post is not a user-facing error.
        report: false,
      },
    );
  } catch (err) {
    // The server is down or restarting — the expected failure, and exactly when
    // these samples matter. Keep them for the next flush. Anything else is a bug.
    if (!(err instanceof EndpointError) && !(err instanceof TypeError))
      throw err;
    restore(batchMinutes, batchInteractions);
    scheduleFlush(FLUSH_DELAY_MS);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
      flushDueAt = Infinity;
    }
    void flush();
  });
}
