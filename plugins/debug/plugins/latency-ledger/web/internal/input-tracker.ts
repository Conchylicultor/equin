// How long a click or a keypress takes to show: every person's interaction, from
// the input to the next painted frame — Event Timing's `duration`, what Web
// Vitals' INP is made of (input delay + handlers + rendering). Before this, only
// the ones over 200 ms were kept (reports/main-thread-stall's slow-interaction
// watch), so "how fast does a click feel" had no p50.
//
// The browser times an interaction only from 16 ms up (the observer's floor).
// A faster one leaves no entry, so it would be missing from the distribution
// and push every percentile up. Each person's pointerdown / keydown is
// therefore counted at dispatch, and one that no interaction claims within a
// second is recorded at the floor: "16 ms or less", an upper bound, never
// dropped. A pointerdown that became a scroll or a drag is no interaction:
// its entries carry interactionId 0 and it is not recorded at all — but one
// under 16 ms leaves no entry and is counted as a fast interaction (a small
// bias toward fast, named here).

interface EventTimingEntry extends PerformanceEntry {
  readonly interactionId: number;
}

const ENTRY_TYPE = "event";
/** Event Timing's lowest `durationThreshold`. */
export const INPUT_FLOOR_MS = 16;
// An entry is delivered after its paint; wait this long before calling an
// interaction "faster than the floor".
const GRACE_MS = 1_000;
// A verdict timer that fires this late ran after a blocked thread — exactly
// when the slow interaction's entry is still on its way (it is delivered after
// the paint the block delayed). Such a verdict waits another grace instead.
const LATE_MS = 100;
const MAX_WAITS = 5;
// An entry's startTime is its event's timeStamp; tolerance when matching.
const MATCH_MS = 1;
// Interactions and dispatches kept for matching.
const KEEP_MS = 30_000;

type Kind = "pointer" | "key";

interface Seen {
  kind: Kind;
  /** The earliest of its entries' startTime (its first event's timeStamp). */
  start: number;
  /** Its longest entry: input → the paint after its slowest handler. */
  durationMs: number;
}

interface Dispatch {
  kind: Kind;
  timeStamp: number;
}

const kindOfEntry = (name: string): Kind =>
  name.startsWith("key") ? "key" : "pointer";

function eventTimingSupported(): boolean {
  return (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes(ENTRY_TYPE) &&
    typeof PerformanceEventTiming !== "undefined" &&
    "interactionId" in PerformanceEventTiming.prototype
  );
}

/**
 * Start recording every trusted click / tap / keypress of this tab through
 * `record(ms)`. Returns the teardown. On a browser without Event Timing's
 * interaction ids nothing is recorded — an absent metric, never a guessed one.
 *
 * Each person's pointerdown / keydown is one interaction (a held key's repeats
 * are not counted). Its time is the longest entry of the interaction it
 * started — grouped by `interactionId`, so a cheap pointerdown followed by a
 * slow click handler is the click's time. An interaction is matched to the
 * first dispatch of its kind at or before its first entry, and judged a grace
 * after the dispatch: with no entry, it was under the floor.
 */
export function startInputTracking(record: (ms: number) => void): () => void {
  if (!eventTimingSupported()) return () => {};
  const seen = new Map<number, Seen>();
  // Entries no interaction owns (interactionId 0): a pointer that became a
  // scroll or a drag leaves these at its own timeStamp.
  const loose: number[] = [];
  const dispatches: Dispatch[] = [];
  const judged = new Set<number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const prune = (now: number): void => {
    for (const [id, x] of seen)
      if (x.start < now - KEEP_MS) {
        seen.delete(id);
        judged.delete(id);
      }
    while (loose.length > 0 && (loose[0] ?? 0) < now - KEEP_MS) loose.shift();
    while (
      dispatches.length > 0 &&
      (dispatches[0]?.timeStamp ?? 0) < now - KEEP_MS
    )
      dispatches.shift();
  };

  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as EventTimingEntry[]) {
      if (e.interactionId === 0) {
        loose.push(e.startTime);
        continue;
      }
      const x = seen.get(e.interactionId);
      if (x) {
        x.start = Math.min(x.start, e.startTime);
        x.durationMs = Math.max(x.durationMs, e.duration);
      } else {
        seen.set(e.interactionId, {
          kind: kindOfEntry(e.name),
          start: e.startTime,
          durationMs: e.duration,
        });
      }
    }
  });
  observer.observe({
    type: ENTRY_TYPE,
    buffered: false,
    durationThreshold: INPUT_FLOOR_MS,
  } as PerformanceObserverInit);

  const judge = (d: Dispatch): void => {
    // The next dispatch of the same kind bounds which interaction is this one's.
    const next = dispatches.find(
      (o) => o.kind === d.kind && o.timeStamp > d.timeStamp,
    );
    let best: [number, Seen] | null = null;
    for (const [id, x] of seen) {
      if (judged.has(id) || x.kind !== d.kind) continue;
      if (x.start < d.timeStamp - MATCH_MS) continue;
      if (next && x.start >= next.timeStamp - MATCH_MS) continue;
      if (!best || x.start < best[1].start) best = [id, x];
    }
    if (best) {
      judged.add(best[0]);
      record(best[1].durationMs);
      return;
    }
    // A pointer that became a scroll or a drag is no interaction.
    if (loose.some((t) => Math.abs(t - d.timeStamp) <= MATCH_MS)) return;
    record(INPUT_FLOOR_MS);
  };

  const wait = (d: Dispatch, waits: number): void => {
    const dueAt = performance.now() + GRACE_MS;
    const t = setTimeout(() => {
      timers.delete(t);
      const now = performance.now();
      if (now - dueAt > LATE_MS && waits < MAX_WAITS) {
        wait(d, waits + 1);
        return;
      }
      judge(d);
      prune(now);
    }, GRACE_MS);
    timers.add(t);
  };

  const onDispatch = (ev: Event): void => {
    if (!ev.isTrusted) return;
    if (ev instanceof KeyboardEvent && ev.repeat) return;
    const d: Dispatch = {
      kind: ev.type === "keydown" ? "key" : "pointer",
      timeStamp: ev.timeStamp,
    };
    dispatches.push(d);
    wait(d, 0);
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", onDispatch, opts);
  // eslint-disable-next-line shortcuts/no-window-key-listener -- measurement only: every keystroke of the page is timed (a passive capture listener that handles none), whichever surface it belongs to
  window.addEventListener("keydown", onDispatch, opts);

  return () => {
    window.removeEventListener("pointerdown", onDispatch, opts);
    window.removeEventListener("keydown", onDispatch, opts);
    observer.disconnect();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
