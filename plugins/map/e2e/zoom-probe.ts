// A zoom-smoothness probe that runs IN the page: every frame's interval, every
// long animation frame with its script time split by origin, and — on a
// Google map (`.gm-style`) — whether the map visibly moved that frame, so a
// gesture's input-to-motion latency, settle tail and continuity can be read
// off. One self-contained function: Playwright injects it (`page.evaluate`),
// and `zoomProbeSource()` is the same code as a snippet to paste into any
// page — google.com/maps included, where the motion part has no `.gm-style`
// to read and reports nothing. See research/2026-10-16-map-zoom-smoothness.md.

import type { Page } from "playwright";

/** One long animation frame (> 50 ms), its time split by what ran. */
export interface ProbeLoaf {
  start: number;
  ms: number;
  blockingMs: number;
  /** Script time by origin: "google" (googleapis / gstatic), "app", "other" (no source URL). */
  scriptMs: Record<string, number>;
  /** From the frame's style-and-layout start to its end. */
  renderMs: number;
}

/** One wheel / pinch gesture: wheel events with no gap over 400 ms. */
export interface ProbeGesture {
  inputs: number;
  /** A trackpad pinch arrives as wheel events with ctrlKey. */
  pinch: boolean;
  inputMs: number;
  /** Input start → first frame the map moved. */
  latencyMs: number | null;
  /** Last input → last frame the map moved (the animation tail). */
  settleMs: number | null;
  /** Of the frames between first and last motion, the share that moved. */
  continuity: number | null;
}

export interface ZoomProbeSummary {
  frames: number;
  durationMs: number;
  gapMs: { p50: number; p90: number; p99: number; max: number };
  /** Frames whose gap exceeded 1.5 × the median gap (a missed vsync). */
  dropped: number;
  loafs: ProbeLoaf[];
  gestures: ProbeGesture[];
  /** Whether a `.gm-style` map was there to read motion from. */
  tracksMotion: boolean;
}

interface ProbeHandle {
  summary: () => ZoomProbeSummary;
  stop: () => void;
}

/**
 * Installs the probe on `window.__zoomProbe` (restarting it when present).
 * Self-contained by construction — it is serialized into the page, so it may
 * not close over anything in this module.
 */
export function installZoomProbe(): void {
  const w = window as unknown as { __zoomProbe?: ProbeHandle };
  w.__zoomProbe?.stop();

  const frames: { t: number; gap: number; moved: boolean }[] = [];
  const inputs: { t: number; pinch: boolean }[] = [];
  const loafs: ProbeLoaf[] = [];
  let running = true;

  // Google's raster panes move by inline `transform` (a zoom animates a
  // matrix scale, a pan a translate): their concatenation changes on exactly
  // the frames the map moved. Inline style reads force no style flush.
  const motionSignature = (): string | null => {
    const root = document.querySelector(".gm-style");
    if (root === null) return null;
    let sig = "";
    for (const el of root.querySelectorAll<HTMLElement>(
      'div[style*="transform"], canvas[style*="transform"]',
    )) {
      sig += `${el.style.transform}|`;
    }
    return sig;
  };

  let last = -1;
  let lastSig = motionSignature();
  const tick = (t: number) => {
    if (!running) return;
    const sig = motionSignature();
    if (last >= 0) frames.push({ t, gap: t - last, moved: sig !== lastSig });
    last = t;
    lastSig = sig;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const onWheel = (e: WheelEvent) => {
    if (running) inputs.push({ t: e.timeStamp, pinch: e.ctrlKey });
  };
  window.addEventListener("wheel", onWheel, { capture: true, passive: true });

  interface LoafScript {
    sourceURL: string;
    duration: number;
  }
  interface LoafEntry extends PerformanceEntry {
    blockingDuration: number;
    styleAndLayoutStart: number;
    scripts: LoafScript[];
  }
  const origin = (url: string): string =>
    url === ""
      ? "other"
      : /googleapis\.com|gstatic\.com|google\.com\/maps/.test(url)
        ? "google"
        : "app";
  const observer = new PerformanceObserver((list) => {
    if (!running) return;
    for (const e of list.getEntries() as LoafEntry[]) {
      const scriptMs: Record<string, number> = {};
      for (const s of e.scripts) {
        const k = origin(s.sourceURL);
        scriptMs[k] = (scriptMs[k] ?? 0) + s.duration;
      }
      const end = e.startTime + e.duration;
      loafs.push({
        start: e.startTime,
        ms: e.duration,
        blockingMs: e.blockingDuration,
        scriptMs,
        renderMs: e.styleAndLayoutStart > 0 ? end - e.styleAndLayoutStart : 0,
      });
    }
  });
  observer.observe({ type: "long-animation-frame", buffered: false });

  const summary = (): ZoomProbeSummary => {
    const gaps = frames.map((f) => f.gap).sort((a, b) => a - b);
    const pct = (p: number) =>
      gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] ?? 0;
    const vsync = pct(0.5);
    const tracksMotion = lastSig !== null;

    const gestures: ProbeGesture[] = [];
    let group: { t: number; pinch: boolean }[] = [];
    const close = () => {
      const first = group[0];
      const lastIn = group.at(-1);
      if (first === undefined || lastIn === undefined) return;
      // Motion belongs to this gesture until the next one starts.
      const next = inputs.find((i) => i.t > lastIn.t + 400);
      const horizon = next?.t ?? Number.POSITIVE_INFINITY;
      const moved = frames.filter(
        (f) => f.moved && f.t >= first.t && f.t < horizon,
      );
      const firstMove = moved[0];
      const lastMove = moved.at(-1);
      const span =
        firstMove === undefined || lastMove === undefined
          ? []
          : frames.filter((f) => f.t >= firstMove.t && f.t <= lastMove.t);
      gestures.push({
        inputs: group.length,
        pinch: group.some((i) => i.pinch),
        inputMs: lastIn.t - first.t,
        latencyMs:
          tracksMotion && firstMove !== undefined
            ? firstMove.t - first.t
            : null,
        settleMs:
          tracksMotion && lastMove !== undefined ? lastMove.t - lastIn.t : null,
        continuity:
          tracksMotion && span.length > 0
            ? span.filter((f) => f.moved).length / span.length
            : null,
      });
      group = [];
    };
    for (const i of inputs) {
      const prev = group.at(-1);
      if (prev !== undefined && i.t - prev.t > 400) close();
      group.push(i);
    }
    close();

    return {
      frames: frames.length,
      durationMs:
        frames.length === 0
          ? 0
          : frames.at(-1)!.t - frames[0]!.t + frames[0]!.gap,
      gapMs: { p50: vsync, p90: pct(0.9), p99: pct(0.99), max: pct(1) },
      dropped: gaps.filter((g) => g > vsync * 1.5).length,
      loafs: [...loafs],
      gestures,
      tracksMotion,
    };
  };

  w.__zoomProbe = {
    summary,
    stop: () => {
      running = false;
      observer.disconnect();
      window.removeEventListener("wheel", onWheel, { capture: true });
    },
  };
}

/** The probe as a snippet for a page Playwright does not drive; `window.__zoomProbe.summary()` reads it. */
export function zoomProbeSource(): string {
  return `(${installZoomProbe.toString()})();`;
}

/** Install (or restart) the probe in `page`. */
export async function startZoomProbe(page: Page): Promise<void> {
  await page.evaluate(installZoomProbe);
}

/** Stop the probe in `page` and read what it recorded. */
export async function stopZoomProbe(page: Page): Promise<ZoomProbeSummary> {
  return page.evaluate(() => {
    const w = window as unknown as { __zoomProbe?: ProbeHandle };
    const probe = w.__zoomProbe;
    if (probe === undefined) throw new Error("zoom probe not installed");
    const s = probe.summary();
    probe.stop();
    return s;
  });
}

/** The summary as report lines. */
export function zoomProbeLines(s: ZoomProbeSummary): string[] {
  const f = (n: number) => n.toFixed(1);
  const lines = [
    `[probe] ${s.frames} frames in ${f(s.durationMs)} ms; gap p50 ${f(s.gapMs.p50)} p90 ${f(s.gapMs.p90)} p99 ${f(s.gapMs.p99)} max ${f(s.gapMs.max)}; dropped ${s.dropped}`,
  ];
  const by: Record<string, number> = {};
  let render = 0;
  let total = 0;
  for (const l of s.loafs) {
    total += l.ms;
    render += l.renderMs;
    for (const [k, v] of Object.entries(l.scriptMs)) by[k] = (by[k] ?? 0) + v;
  }
  lines.push(
    `[probe] long frames ${s.loafs.length} (${total.toFixed(0)} ms, max ${Math.max(0, ...s.loafs.map((l) => l.ms)).toFixed(0)}): script ${Object.entries(
      by,
    )
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v.toFixed(0)}`)
      .join(", ")}; style+layout+paint ${render.toFixed(0)} ms`,
  );
  if (!s.tracksMotion) {
    lines.push("[probe] no .gm-style map: motion not tracked");
    return lines;
  }
  const ms = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)} ms`);
  // No motion at all, or motion ending before the input does: the map was at
  // its zoom limit for (part of) the gesture.
  const settle = (v: number | null) =>
    v !== null && v < 0
      ? `none (motion stopped ${(-v).toFixed(0)} ms before the input)`
      : ms(v);
  for (const [i, g] of s.gestures.entries()) {
    lines.push(
      `[probe] gesture ${i + 1}${g.pinch ? " (pinch)" : ""}: ${g.inputs} inputs over ${g.inputMs.toFixed(0)} ms; latency ${ms(g.latencyMs)}, settle ${settle(g.settleMs)}, moved ${g.continuity === null ? "—" : `${(g.continuity * 100).toFixed(0)}%`} of frames`,
    );
  }
  return lines;
}
