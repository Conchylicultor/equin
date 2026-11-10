import type { Locator, Page } from "playwright";

/**
 * Elements restyled by one desktop ↔ full screen switch, read from Chrome's
 * trace: the sum of every style recalc's (`UpdateLayoutTree`) element count
 * between the gesture and the end of the settle window.
 *
 * The work, not its time: the count does not drift with how busy the host is
 * (±0.5 % run to run, where CPU time varies 2–3×), so a budget over it is a
 * regression guard rather than a flake. A whole-document restyle — a custom
 * property written on `<html>`, a root theme swap, a selector toggled high in
 * the tree, hidden tabs that must be restyled to show — shows up as a jump of
 * the order of the document's element count.
 */

/** A trace event, as far as the style-recalc tally reads one. */
export interface StyleTraceEvent {
  name: string;
  ph: string;
  ts?: number;
  args?: {
    elementCount?: number;
    data?: { elementCount?: number } & Record<string, unknown>;
  };
}

/** A recalc restyling at least this many elements is a whole-document one. */
export const BIG_RECALC = 5000;

/** Elements restyled by each style recalc (UpdateLayoutTree) in a trace. */
export function styleRecalcs(trace: Buffer): number[] {
  const { traceEvents } = JSON.parse(trace.toString("utf8")) as {
    traceEvents: StyleTraceEvent[];
  };
  return traceEvents
    .filter(
      (e) => e.name === "UpdateLayoutTree" && (e.ph === "X" || e.ph === "E"),
    )
    .map((e) => e.args?.elementCount ?? e.args?.data?.elementCount ?? 0)
    .filter((n) => n > 0);
}

/** What one traced switch measured. */
export interface TracedSwitch {
  /** Elements restyled in total. */
  styled: number;
  /** Each recalc's element count, in trace order. */
  recalcs: number[];
  /** Gesture → the shown window set changed, wall ms. */
  flippedAtMs: number;
}

type ProbeWindow = Window & {
  __switchProbe?: { t0: number; flippedAt: number | null };
};

/**
 * Trace one switch: arm a probe on `root` (the shown desktop windows, counted
 * once a frame after the commit), start a `devtools.timeline` trace, run
 * `gesture`, wait for the shown window set to change and then `settleMs` more
 * (what the switch sets off late — a remeasure, a transition — counts too),
 * and tally the trace's style recalcs.
 *
 * The flip is read from the windows, not a tab container's position: entering
 * full screen hides every window, leaving it shows them again, wherever the
 * desktop is drawn (the page's own surface or an `AppEmbed`'s).
 */
export async function traceSwitch(
  page: Page,
  root: Locator,
  gesture: () => Promise<void>,
  opts: { settleMs: number; categories?: string[] },
): Promise<TracedSwitch & { trace: Buffer }> {
  await root.evaluate((el) => {
    const shown = () =>
      [...el.querySelectorAll<HTMLElement>("[data-floating-window-id]")]
        .filter((w) => w.checkVisibility())
        .map((w) => w.getAttribute("data-floating-window-id"))
        .sort()
        .join(",");
    const armed = shown();
    const probe = { t0: performance.now(), flippedAt: null as number | null };
    (window as ProbeWindow).__switchProbe = probe;
    const check = () => {
      if (shown() !== armed) {
        probe.flippedAt = performance.now() - probe.t0;
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  const browser = page.context().browser();
  if (browser === null) throw new Error("no browser to trace");
  await browser.startTracing(page, {
    categories: ["devtools.timeline", ...(opts.categories ?? [])],
  });
  await gesture();
  await page.waitForFunction(
    () => (window as ProbeWindow).__switchProbe?.flippedAt != null,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(opts.settleMs);
  const trace = await browser.stopTracing();
  const flippedAtMs = await page.evaluate(
    () => (window as ProbeWindow).__switchProbe?.flippedAt ?? -1,
  );
  const recalcs = styleRecalcs(trace);
  return {
    styled: recalcs.reduce((n, r) => n + r, 0),
    recalcs,
    flippedAtMs,
    trace,
  };
}
