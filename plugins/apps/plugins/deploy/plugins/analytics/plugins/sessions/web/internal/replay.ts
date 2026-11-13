import type {
  DeviceFamily,
  GapKind,
  LoadTiming,
  Viewport,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import type { Journey, PageAction } from "./journey";

/**
 * A visit as something to play: one clock, in seconds from the page load's
 * start — the recorded load first (`loadS`, the visitor's own wait until the
 * app was ready, when the tracker's first pageview went out), then the visit
 * (`loadS + visit seconds`). Pure: the pane drives a frame from it.
 */
export interface ReplayScript {
  /** How long the visitor waited for the first page: its ready time (else first paint, else server); 0 when not recorded. */
  loadS: number;
  /** The recorded load, for the veil's phases; null when not recorded. */
  load: LoadTiming | null;
  /** The whole replay: the load plus the visit. */
  totalS: number;
  pages: ReplayPage[];
  /** Every step, in time order: what the step list and the scrubber draw. */
  steps: ReplayStep[];
}

export interface ReplayPage {
  index: number;
  path: string;
  /** On the replay clock. */
  startS: number;
  endS: number;
  viewport: Viewport | null;
}

export type ReplayStep =
  | { kind: "page"; atS: number; page: number; path: string }
  | {
      kind: "section";
      atS: number;
      page: number;
      /** The key the timeline shows (`hero`). */
      section: string;
      /** The full name the page registered (`landing/hero`): what the frame scrolls to. */
      name: string;
    }
  | { kind: "action"; atS: number; page: number; action: PageAction }
  | { kind: "away"; atS: number; endS: number; page: number; gap: GapKind }
  | { kind: "end"; atS: number; page: number };

export function replayScriptOf(
  journey: Journey,
  load: LoadTiming | null,
): ReplayScript {
  const loadMs = load ? (load.readyMs ?? load.fcpMs ?? load.ttfbMs ?? 0) : 0;
  const loadS = loadMs / 1000;
  const pages: ReplayPage[] = journey.pages.map((p, index) => ({
    index,
    path: p.path,
    startS: loadS + p.startS,
    endS: loadS + p.startS + p.durationS,
    viewport: p.viewport,
  }));
  const steps: ReplayStep[] = [];
  journey.pages.forEach((p, page) => {
    const at = (s: number) => loadS + p.startS + s;
    steps.push({ kind: "page", atS: at(0), page, path: p.path });
    for (const r of p.reached)
      steps.push({
        kind: "section",
        atS: at(r.atS),
        page,
        section: r.section,
        name: r.name,
      });
    for (const action of p.actions)
      steps.push({ kind: "action", atS: at(action.atS), page, action });
    for (const g of p.gaps ?? [])
      steps.push({
        kind: "away",
        atS: at(g.startS),
        endS: at(g.endS),
        page,
        gap: g.kind,
      });
  });
  steps.sort(
    (a, b) => a.atS - b.atS || STEP_ORDER[a.kind] - STEP_ORDER[b.kind],
  );
  // A hit can land past the visit's duration (an event after the exit
  // page's last beacon): the replay runs until its last step.
  const totalS = Math.max(loadS + journey.durationS, steps.at(-1)?.atS ?? 0);
  steps.push({ kind: "end", atS: totalS, page: pages.length - 1 });
  return { loadS, load, totalS, pages, steps };
}

/** At one instant, a page's opening comes before what happens on it. */
const STEP_ORDER: Record<ReplayStep["kind"], number> = {
  page: 0,
  section: 1,
  away: 2,
  action: 3,
  end: 4,
};

/** What the frame should show at one instant of the replay. */
export interface ReplayFrameState {
  /** Still in the recorded page load. */
  loading: boolean;
  /** The page on screen (the first during the load). */
  page: number;
  /** The last section reached on that page by now (its full name), or null: the page's top. */
  section: string | null;
  /** The stretch away running now, if any. */
  away: Extract<ReplayStep, { kind: "away" }> | null;
}

export function frameStateAt(
  script: ReplayScript,
  t: number,
): ReplayFrameState {
  let page = 0;
  let section: string | null = null;
  let away: ReplayFrameState["away"] = null;
  for (const step of script.steps) {
    if (step.atS > t) break;
    if (step.kind === "page") {
      page = step.page;
      section = null;
    } else if (step.kind === "section") section = step.name;
    else if (step.kind === "away" && step.endS > t) away = step;
  }
  if (away !== null && away.page !== page) away = null;
  return { loading: t < script.loadS, page, section, away };
}

/** How long an action stays on screen as a toast, in replay seconds. */
export const ACTION_SHOWN_S = 2.5;

/** The actions fired in the last {@link ACTION_SHOWN_S} — the toasts on screen at `t`. */
export function recentActions(
  script: ReplayScript,
  t: number,
): Extract<ReplayStep, { kind: "action" }>[] {
  return script.steps.filter(
    (s): s is Extract<ReplayStep, { kind: "action" }> =>
      s.kind === "action" && s.atS <= t && t - s.atS < ACTION_SHOWN_S,
  );
}

/** The index of the last step at or before `t` (−1 before the first). */
export function currentStep(script: ReplayScript, t: number): number {
  let i = -1;
  script.steps.forEach((s, j) => {
    if (s.atS <= t) i = j;
  });
  return i;
}

/**
 * The size to play the visit at: the page's own recorded viewport, else the
 * nearest page's that recorded one, else a typical screen of the visitor's
 * device kind — marked `estimated`, never passed off as theirs.
 */
export interface ReplayViewport extends Viewport {
  estimated: boolean;
}

const TYPICAL: Record<DeviceFamily, Viewport> = {
  Desktop: { w: 1440, h: 900 },
  Mobile: { w: 390, h: 844 },
  Tablet: { w: 820, h: 1180 },
};

export function viewportAt(
  script: ReplayScript,
  page: number,
  device: DeviceFamily,
): ReplayViewport {
  const own = script.pages[page]?.viewport;
  if (own) return { ...own, estimated: false };
  // The nearest page before it that recorded one, else after it.
  for (let d = 1; d < script.pages.length; d++) {
    const v =
      script.pages[page - d]?.viewport ?? script.pages[page + d]?.viewport;
    if (v) return { ...v, estimated: false };
  }
  return { ...TYPICAL[device], estimated: true };
}

/**
 * Where playing on from `t` lands when stretches away are skipped: past the
 * end of the stretch running at `t`, else `t` itself.
 */
export function skipAway(script: ReplayScript, t: number): number {
  const away = frameStateAt(script, t).away;
  return away === null ? t : away.endS;
}
