import { z } from "zod";
import {
  StallClientSchema,
  type StallClient,
} from "@plugins/reports/plugins/main-thread-stall/core";

/**
 * A site visitor's slow page load, as a report. The site's analytics already
 * measures every load (`analytics/collect`'s `LoadTiming`), but a number in a
 * visit row reaches nobody: only a report reaches the computer's Reports.
 * This kind is that report, judged on the same milestones.
 */
export const SLOW_PAGE_LOAD_KIND = "slow-page-load";

/**
 * A load is slow once the page was not ready this long after the navigation
 * started — about the 85th percentile of equin.ai's own loads (2026-11-12 →
 * 11-19: p50 1.5 s, p75 2.4 s, p90 3.7 s, 15 % at or past 3 s), so what is
 * reported is the slow tail, not every visit.
 */
export const SLOW_PAGE_LOAD_BAR_MS = 3_000;

/** A phase past this is a suspended page, not a load (analytics' `MAX_LOAD_MS`). */
const MAX_LOAD_MS = 10 * 60 * 1000;

/** The load's milestones, ms from the navigation's start; null = not reached. */
export interface LoadMilestones {
  /** The document's first byte. */
  ttfbMs: number | null;
  /** The first contentful paint. */
  fcpMs: number | null;
  /** The app was up: the later of first paint and the route's content commit. */
  readyMs: number | null;
}

/**
 * Where the load's time went, by its largest stretch:
 * - `server` — waiting for the document's first byte (network + server);
 * - `first-paint` — first byte → first paint (downloading and running the
 *   page's code and styles);
 * - `app-ready` — first paint → the route's content (the app booting).
 * - `not-ready` — the visitor hid or left the page before it was ready.
 */
export const SLOW_LOAD_PHASES = [
  "server",
  "first-paint",
  "app-ready",
  "not-ready",
] as const;
export type SlowLoadPhase = (typeof SLOW_LOAD_PHASES)[number];

/** The network the browser says it is on (Chrome's Network Information API). */
export const CONNECTION_TYPES = ["slow-2g", "2g", "3g", "4g"] as const;

const LoadMsSchema = z.number().int().positive().max(MAX_LOAD_MS).nullable();

/**
 * The report's payload: the load's milestones and what is needed to read
 * them — the coarse browser (family and OS, never the user agent), the
 * network class — and nothing that names the visitor.
 */
export const SlowPageLoadPayloadSchema = z
  .object({
    phase: z.enum(SLOW_LOAD_PHASES),
    ttfbMs: LoadMsSchema,
    fcpMs: LoadMsSchema,
    readyMs: LoadMsSchema,
    /** For `not-ready`: how long after the navigation the page was hidden. */
    hiddenAtMs: LoadMsSchema,
    barMs: z.number().int().positive(),
    client: StallClientSchema,
    connection: z.enum(CONNECTION_TYPES).nullable(),
  })
  .strict();
export type SlowPageLoadPayload = z.infer<typeof SlowPageLoadPayloadSchema>;

/** A measured instant as whole positive ms, or null (analytics' `loadMs`). */
function wholeMs(ms: number | null): number | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const whole = Math.ceil(ms);
  return whole > MAX_LOAD_MS ? null : whole;
}

function largestPhase(m: LoadMilestones, readyMs: number): SlowLoadPhase {
  const ttfb = m.ttfbMs ?? 0;
  const fcp = m.fcpMs ?? readyMs;
  const stretches: [SlowLoadPhase, number][] = [
    ["server", ttfb],
    ["first-paint", fcp - ttfb],
    ["app-ready", readyMs - fcp],
  ];
  return stretches.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

interface Context {
  client: StallClient;
  connection: SlowPageLoadPayload["connection"];
  barMs?: number;
}

/**
 * The verdict on a load that became ready: a payload when it took the bar or
 * more, else null (a fast load reports nothing). PURE.
 */
export function judgeReadyLoad(
  m: LoadMilestones,
  ctx: Context,
): SlowPageLoadPayload | null {
  const barMs = ctx.barMs ?? SLOW_PAGE_LOAD_BAR_MS;
  const readyMs = wholeMs(m.readyMs);
  if (readyMs === null || readyMs < barMs) return null;
  return {
    phase: largestPhase(m, readyMs),
    ttfbMs: wholeMs(m.ttfbMs),
    fcpMs: wholeMs(m.fcpMs),
    readyMs,
    hiddenAtMs: null,
    barMs,
    client: ctx.client,
    connection: ctx.connection,
  };
}

/**
 * The verdict on a load hidden before it was ready, `hiddenAtMs` after the
 * navigation: the visitor waited the bar or more and saw no page (they left,
 * or looked elsewhere). Shorter, it says nothing about the load. PURE.
 */
export function judgeHiddenLoad(
  m: LoadMilestones,
  hiddenAtMs: number,
  ctx: Context,
): SlowPageLoadPayload | null {
  const barMs = ctx.barMs ?? SLOW_PAGE_LOAD_BAR_MS;
  // A page never ready for longer than a plausible load is still the worst
  // load of all: clamped, never dropped.
  const hidden = wholeMs(Math.min(hiddenAtMs, MAX_LOAD_MS));
  if (hidden === null || hidden < barMs) return null;
  return {
    phase: "not-ready",
    ttfbMs: wholeMs(m.ttfbMs),
    fcpMs: wholeMs(m.fcpMs),
    readyMs: null,
    hiddenAtMs: hidden,
    barMs,
    client: ctx.client,
    connection: ctx.connection,
  };
}

const MOBILE_OSES: ReadonlySet<StallClient["os"]> = new Set(["ios", "android"]);

/**
 * One row per (phase, phone or not): a bounded set of eight, each counting
 * every slow load of its kind, its latest sample the row's payload and path.
 */
export function slowPageLoadFingerprint(p: SlowPageLoadPayload): string {
  return `${p.phase}:${MOBILE_OSES.has(p.client.os) ? "mobile" : "desktop"}`;
}

const PHASE_WORDS: Record<SlowLoadPhase, string> = {
  server: "mostly waiting for the server",
  "first-paint": "mostly before the first paint",
  "app-ready": "mostly the app starting after the first paint",
  "not-ready": "hidden before it was ready",
};

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

/** The report's one-line message. */
export function slowPageLoadSummary(p: SlowPageLoadPayload): string {
  const head =
    p.phase === "not-ready"
      ? `Slow page load: not ready after ${seconds(p.hiddenAtMs)}`
      : `Slow page load: ready after ${seconds(p.readyMs)}`;
  const net = p.connection ? `, ${p.connection}` : "";
  return `${head} (first byte ${seconds(p.ttfbMs)}, first paint ${seconds(p.fcpMs)}) — ${PHASE_WORDS[p.phase]}; ${p.client.os}/${p.client.family}${net}`;
}
