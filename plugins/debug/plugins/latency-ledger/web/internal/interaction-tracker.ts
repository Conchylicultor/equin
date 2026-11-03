import {
  pendingMountSnapshot,
  subscribePendingMounts,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { currentRoutePath } from "@plugins/primitives/plugins/pane/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import type { Interaction } from "../../core";

// When is what the user just opened "on screen"?
//
// An interaction (a page load, or a click that opens another screen) ends when
// every list that started loading during it has its data, and that stays true for
// a short quiet window. The quiet window exists because the new screen's components
// mount a little after the click — its code may load lazily — so "nothing is
// loading" at the instant of the click means nothing yet. The DURATION recorded is
// up to the moment the last list got its data (plus one painted frame), not up to
// the end of the quiet window.

const QUIET_MS = 400;
// A screen still waiting after this long is recorded as "at least this long".
const CAP_MS = 60_000;

interface Active {
  kind: Interaction["kind"];
  /** `performance.now()` at the start (0 for the page load: navigation start). */
  startMs: number;
  startedTotalAtStart: number;
  hidden: boolean;
  /** `performance.now()` at which the count last reached zero, if it is zero now. */
  settledAtMs: number | null;
  quietTimer: ReturnType<typeof setTimeout> | null;
  capTimer: ReturnType<typeof setTimeout>;
}

let active: Active | null = null;
let report: ((interaction: Interaction) => void) | null = null;

function finish(a: Active, endMs: number, censored: boolean): void {
  if (active !== a) return;
  active = null;
  if (a.quietTimer !== null) clearTimeout(a.quietTimer);
  clearTimeout(a.capTimer);
  const snap = pendingMountSnapshot();
  // One line per page load / navigation — a handful a day. When a screen never
  // finished, the line names the lists it was still waiting for.
  clientLog(
    "latency-ledger",
    `${a.kind} ${Math.round(Math.max(0, endMs - a.startMs))}ms route=${currentRoutePath()} lists=${snap.startedTotal - a.startedTotalAtStart}` +
      (censored
        ? ` CENSORED waiting-for=[${snap.pendingKeys.join(", ")}]`
        : "") +
      (a.hidden ? " hidden" : ""),
  );
  report?.({
    kind: a.kind,
    occurredAt: Date.now(),
    route: currentRoutePath(),
    durationMs: Math.max(0, endMs - a.startMs),
    hidden: a.hidden,
    censored,
    resourceCount: snap.startedTotal - a.startedTotalAtStart,
    lastResourceKey: snap.lastReleasedKey,
  });
}

function armQuiet(a: Active): void {
  if (a.quietTimer !== null) clearTimeout(a.quietTimer);
  a.quietTimer = setTimeout(() => {
    a.quietTimer = null;
    if (a.settledAtMs !== null) finish(a, a.settledAtMs, false);
  }, QUIET_MS);
}

function onCount(pending: number): void {
  const a = active;
  if (a === null) return;
  if (pending > 0) {
    // Something started loading again: not settled after all.
    a.settledAtMs = null;
    if (a.quietTimer !== null) {
      clearTimeout(a.quietTimer);
      a.quietTimer = null;
    }
    return;
  }
  if (a.settledAtMs !== null) return;
  // Data is in the cache now; it is on screen one frame later. A hidden tab gets
  // no animation frame at all (that is how a 26-minute "page load" was once
  // recorded), so there the cache time is the end.
  a.settledAtMs = performance.now();
  if (document.visibilityState === "visible") {
    requestAnimationFrame(() => {
      if (active === a && a.settledAtMs !== null)
        a.settledAtMs = performance.now();
    });
  }
  armQuiet(a);
}

function begin(kind: Interaction["kind"], startMs: number): void {
  // A new interaction cuts the previous one short. It is recorded, as "at least
  // this long": a user who leaves a slow screen because it is slow must not make
  // that screen's sample disappear.
  if (active !== null) finish(active, performance.now(), true);
  const snap = pendingMountSnapshot();
  const a: Active = {
    kind,
    startMs,
    startedTotalAtStart: kind === "page-load" ? 0 : snap.startedTotal,
    hidden: document.visibilityState === "hidden",
    settledAtMs: null,
    quietTimer: null,
    capTimer: setTimeout(() => finish(a, performance.now(), true), CAP_MS),
  };
  active = a;
  onCount(snap.pending);
}

/**
 * Start tracking. `onInteraction` receives every finished page load and
 * navigation. Returns the teardown.
 */
export function startInteractionTracking(
  onInteraction: (interaction: Interaction) => void,
): () => void {
  report = onInteraction;
  const unsubscribe = subscribePendingMounts(onCount);
  const onVisibility = (): void => {
    if (active !== null && document.visibilityState === "hidden")
      active.hidden = true;
  };
  const onNavigate = (): void => begin("navigate", performance.now());
  document.addEventListener("visibilitychange", onVisibility);
  // `shell:navigate` is every programmatic in-app navigation; `popstate` is the
  // browser's back and forward buttons.
  window.addEventListener("shell:navigate", onNavigate);
  window.addEventListener("popstate", onNavigate);
  // The page load itself: `performance.now()` counts from navigation start.
  begin("page-load", 0);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("shell:navigate", onNavigate);
    window.removeEventListener("popstate", onNavigate);
    if (active !== null) {
      if (active.quietTimer !== null) clearTimeout(active.quietTimer);
      clearTimeout(active.capTimer);
      active = null;
    }
    report = null;
  };
}
