import type {
  LoadTiming,
  Session,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/**
 * How the visit's page load went: the first hard load among its hits (a visit
 * may hold several — reloads — and the row shows the first that measured
 * anything). `null` = not recorded (an older tracker, or only in-app
 * navigations shown).
 */
export function visitLoad(session: Session): LoadTiming | null {
  for (const hit of session.hits)
    if (hit.kind === "pageview" && hit.load !== null && measuredAny(hit.load))
      return hit.load;
  return null;
}

function measuredAny(load: LoadTiming): boolean {
  return load.ttfbMs !== null || load.fcpMs !== null || load.readyMs !== null;
}

/** How a ready time reads: green under 1.5 s, amber under 3 s, red past it. */
export type LoadTone = "ok" | "warn" | "bad";

export function loadTone(readyMs: number): LoadTone {
  return readyMs < 1500 ? "ok" : readyMs < 3000 ? "warn" : "bad";
}

/** `ms` as seconds with `digits` decimals: `0.9 s`, `0.91 s`. */
export function seconds(ms: number, digits: 1 | 2): string {
  return `${(ms / 1000).toFixed(digits)} s`;
}

/** One measured phase of a load, ending `endMs` after the navigation started. */
export interface LoadPhase {
  key: "server" | "paint" | "ready";
  endMs: number;
  /** Where its share of the bar starts: the furthest phase before it ended (0 for the first). */
  startMs: number;
  /** Its share of the load's bar: from the phase before it (0 for the first) to its end. */
  spanMs: number;
}

/**
 * The phases a load measured, in order — server response, first paint, ready
 * — each only when measured (a background-tab load keeps the server time
 * alone). Never a 0-length stand-in for an unmeasured one.
 */
export function loadPhases(load: LoadTiming): LoadPhase[] {
  const measured: [LoadPhase["key"], number | null][] = [
    ["server", load.ttfbMs],
    ["paint", load.fcpMs],
    ["ready", load.readyMs],
  ];
  const out: LoadPhase[] = [];
  let prev = 0;
  for (const [key, endMs] of measured) {
    if (endMs === null) continue;
    out.push({ key, endMs, startMs: prev, spanMs: Math.max(0, endMs - prev) });
    prev = Math.max(prev, endMs);
  }
  return out;
}

/** "Server 140 ms · first paint 0.62 s · ready 0.91 s" — the measured phases in words. */
export function loadSummary(load: LoadTiming): string {
  return loadPhases(load)
    .map((p) =>
      p.key === "server"
        ? `server ${p.endMs} ms`
        : `${p.key === "paint" ? "first paint" : "ready"} ${seconds(p.endMs, 2)}`,
    )
    .join(" · ")
    .replace(/^./, (c) => c.toUpperCase());
}
