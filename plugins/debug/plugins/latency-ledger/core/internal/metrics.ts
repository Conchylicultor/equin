// What the ledger measures, and the bar each number is held to. Plain data in
// `core/` because the browser collector, the server recorder, the query and the
// Stats card all read the same closed list.

export const LATENCY_METRICS = [
  "page-load",
  "navigate",
  "update-e2e",
  "deliver-server",
  "watch-delivery",
  "turn-echo",
  "thread-lag",
] as const;
export type LatencyMetric = (typeof LATENCY_METRICS)[number];

export const METRIC_LABELS: Record<
  LatencyMetric,
  { label: string; what: string }
> = {
  "page-load": {
    label: "Page load",
    what: "Opening the app in a browser tab, until every list on screen has its data.",
  },
  navigate: {
    label: "Navigation",
    what: "A click that opens another screen inside the app, until every list on it has its data.",
  },
  "update-e2e": {
    label: "Update delay",
    what: "A change on the server, until an open tab has applied it. Starts at the database's own clock.",
  },
  "deliver-server": {
    label: "Delivery (server side)",
    what: "From the server noticing a change to sending it. Blind to a stalled server: its clock starts when the server gets round to reading the change.",
  },
  "watch-delivery": {
    label: "File change heard",
    what: "A write to a watched file, until the app's watch hears it — the operating system's delay, before anything of the app's runs. A value read from files is that much late before its update even starts.",
  },
  "turn-echo": {
    label: "Message shown",
    what: "The agent taking a sent message, until the transcript line it wrote is on screen in an open tab.",
  },
  "thread-lag": {
    label: "Server thread lag",
    what: "The worst delay of the serving thread in each 10-second window.",
  },
};

/** Metrics the browser reports (the server records the others itself). */
export const CLIENT_METRICS = [
  "page-load",
  "navigate",
  "update-e2e",
  "turn-echo",
] as const;
export type ClientLatencyMetric = (typeof CLIENT_METRICS)[number];

// A minute is "under pressure" when the machine was short of memory in it, or the
// cluster sentinel had its duress latch set. The two memory bars are the ones the
// track's evidence was cut with (2026-09-18); the latch trips later and on more
// signals, so it is OR-ed in, not substituted. Decided at QUERY time from the raw
// per-minute values, so this bar can be re-cut without rewriting history. The rule
// itself is written once, in the server's summary query (`minuteClass`); these are
// its two numbers, here so the card can show them.
export const PRESSURE_DECOMPRESSIONS_PER_SEC = 20_000;
export const PRESSURE_FREE_MEM_MB = 200;

/** The serving thread "stalled" in a 10 s window when its worst lag passed this. */
export const THREAD_STALL_MS = 200;

// The track's exit criteria ("App performance and responsiveness"), as data.
export interface ExitCriterion {
  id: string;
  label: string;
  metric: LatencyMetric;
  minuteClass: "calm" | "pressure";
  /** The bar, in ms. */
  targetMs: number;
  /** `p95`: the 95th percentile must be under the bar. `max`: no sample over it. */
  stat: "p95" | "max";
}

export const EXIT_CRITERIA: readonly ExitCriterion[] = [
  {
    id: "page-load-calm",
    label: "Page load, calm",
    metric: "page-load",
    minuteClass: "calm",
    targetMs: 1_000,
    stat: "p95",
  },
  {
    id: "page-load-pressure",
    label: "Page load, under pressure",
    metric: "page-load",
    minuteClass: "pressure",
    targetMs: 3_000,
    stat: "p95",
  },
  {
    id: "navigate-calm",
    label: "Navigation, calm",
    metric: "navigate",
    minuteClass: "calm",
    targetMs: 1_000,
    stat: "p95",
  },
  {
    id: "navigate-pressure",
    label: "Navigation, under pressure",
    metric: "navigate",
    minuteClass: "pressure",
    targetMs: 3_000,
    stat: "p95",
  },
  {
    id: "update-calm",
    label: "Update delay, calm",
    metric: "update-e2e",
    minuteClass: "calm",
    targetMs: 1_000,
    stat: "p95",
  },
  {
    id: "update-pressure",
    label: "Update delay, under pressure",
    metric: "update-e2e",
    minuteClass: "pressure",
    targetMs: 5_000,
    stat: "p95",
  },
  {
    id: "thread-calm",
    label: "Serving thread, calm",
    metric: "thread-lag",
    minuteClass: "calm",
    targetMs: THREAD_STALL_MS,
    stat: "max",
  },
  {
    id: "thread-pressure",
    label: "Serving thread, under pressure",
    metric: "thread-lag",
    minuteClass: "pressure",
    targetMs: THREAD_STALL_MS,
    stat: "max",
  },
];

/** Epoch ms of the start of the minute containing `ms`. */
export function minuteStartOf(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}
