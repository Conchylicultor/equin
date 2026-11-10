import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import type {
  InteractionTarget,
  SlowInteractionPayload,
  StallFrame,
  StallTab,
} from "../../core";
import { fileSlowInteraction } from "./file-slow-interaction";
import {
  INTERACTION,
  attribute,
  frameClaimed,
  judgeInteraction,
  longestEntry,
  phasesOf,
  type EventTimingLike,
  type InteractionWindow,
  type RawFrame,
} from "./interaction-judge";
import { interactionTarget, keyClass } from "./interaction-target";
import { toStallFrame, type LoafEntry } from "./loaf";
import { LOG_CHANNEL } from "./log-channel";

// Event Timing (Chrome 76+, interactionId 96+), not complete in TS's DOM lib.
interface EventTimingEntry extends PerformanceEntry, EventTimingLike {
  readonly target: Node | null;
}

const EVENT_ENTRY_TYPE = "event";

function eventTimingSupported(): boolean {
  return (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes(EVENT_ENTRY_TYPE) &&
    typeof PerformanceEventTiming !== "undefined" &&
    "interactionId" in PerformanceEventTiming.prototype
  );
}

// The first event of each kind of interaction, resolved at dispatch: a
// pointer interaction's pointerdown (and its click, which a keyboard can raise
// alone), a keyboard one's keydown. An interaction's later entries (pointerup,
// keyup) share its interactionId, so they need no target of their own.
const DISPATCHED: Record<string, InteractionTarget["kind"]> = {
  pointerdown: "click",
  click: "click",
  keydown: "key",
};

/** What the tab knew when an interaction began: its target, and where it was. */
interface Origin {
  target: InteractionTarget;
  // Read at dispatch: a click that navigates must be filed under the screen it
  // was made on, not the one it led to.
  tab: StallTab;
}

interface Dispatched extends Origin {
  kind: InteractionTarget["kind"];
  timeStamp: number;
}

interface Pending {
  entries: EventTimingEntry[];
  origin: Origin | null;
}

export interface InteractionWatch {
  /** Every LoAF entry the tab observes (attribution + frame claiming). */
  onFrame(entry: LoafEntry): void;
  /**
   * A 1–5 s long frame: filed by `file` as a `main-thread` slow-op after the
   * grace, unless a slow interaction overlapping it owns it by then.
   */
  deferSlowFrame(frame: StallFrame, file: () => void): void;
  dispose(): void;
}

// Interaction ids already judged, so an entry arriving after its grace (a key
// held past it: keyup long after keydown) is neither filed nor counted twice.
const JUDGED_RING = 64;

/**
 * The slow-interaction half of the tab watch: Event Timing entries (input →
 * next paint) grouped by interaction, their target resolved at dispatch, their
 * time split by the long frames inside them; each slow one is recorded as an
 * `interaction` slow-op and, when severe or recurring, reported.
 *
 * An interaction is judged on its OWN time — its handlers and what they led to
 * (processing + presentation), not its input delay: a click landing while an
 * unrelated long task holds the thread waits for that task, which is the long
 * frame's own (`main-thread` slow-op), never the clicked control's.
 */
export function installInteractionWatch(
  readTab: () => StallTab,
): InteractionWatch {
  const frames: RawFrame[] = [];
  const dispatched: Dispatched[] = [];
  // Slow interactions' own windows (handlers → paint), for frame claiming.
  const slow: InteractionWindow[] = [];
  const pending = new Map<number, Pending>();
  const judged: number[] = [];
  // Per target: interactions with ≥ RECUR_MIN_MS of their own in this page
  // load (bounded by the distinct controls clicked).
  const recur = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const after = (ms: number, fn: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const prune = (now: number): void => {
    const horizon = now - INTERACTION.FRAME_RING_MS;
    while (frames[0] && frames[0].end < horizon) frames.shift();
    while (slow[0] && slow[0].end < horizon) slow.shift();
  };

  // Capture phase on window: runs before any handler, while the target is in
  // the document.
  const onDispatch = (ev: Event): void => {
    const kind = DISPATCHED[ev.type];
    if (!kind) return;
    const key = ev instanceof KeyboardEvent ? keyClass(ev) : null;
    dispatched.push({
      kind,
      timeStamp: ev.timeStamp,
      target: interactionTarget(ev.target, kind, key),
      tab: readTab(),
    });
    if (dispatched.length > INTERACTION.DISPATCH_RING) dispatched.shift();
  };

  // Matched as the entry arrives (right after its paint), while its dispatch is
  // still in the ring. An entry's startTime is its event's timeStamp.
  const originOf = (e: EventTimingEntry): Origin | null => {
    const kind = e.name.startsWith("key") ? "key" : "click";
    const hit = dispatched.find(
      (d) =>
        d.kind === kind &&
        Math.abs(d.timeStamp - e.startTime) <= INTERACTION.DISPATCH_MATCH_MS,
    );
    if (hit) return hit;
    // A pointerup / keyup alone: resolve from the entry's own target, if it is
    // still in the document.
    if (e.name === "pointerup" || e.name === "keyup") return null;
    return { target: interactionTarget(e.target, kind, null), tab: readTab() };
  };

  const judge = (id: number): void => {
    const p = pending.get(id);
    pending.delete(id);
    judged.push(id);
    if (judged.length > JUDGED_RING) judged.shift();
    if (!p) return;
    const e = longestEntry(p.entries);
    const origin = p.origin ?? {
      target: interactionTarget(
        e.target,
        e.name.startsWith("key") ? "key" : "click",
        null,
      ),
      tab: readTab(),
    };
    const { target, tab } = origin;
    if (!tab.visible) return;
    const phases = phasesOf(e);
    const ownMs = e.duration - phases.inputDelayMs;
    const recurKey = JSON.stringify(target);
    const count =
      (recur.get(recurKey) ?? 0) + (ownMs >= INTERACTION.RECUR_MIN_MS ? 1 : 0);
    recur.set(recurKey, count);
    const verdict = judgeInteraction(ownMs, count);
    const a = attribute(
      { start: e.startTime, end: e.startTime + e.duration },
      frames,
    );
    const payload: SlowInteractionPayload = {
      target,
      eventType: e.name,
      startedAt: Math.round(performance.timeOrigin + e.startTime),
      durationMs: Math.round(e.duration),
      ...phases,
      breakdown: a.breakdown,
      topFunction: a.topFunction,
      forcedBy: a.forcedBy,
      frames: a.frames,
      pageCount: count,
      tabId: tab.tabId,
      app: tab.app,
      routePattern: tab.routePattern,
      url: tab.url,
    };
    clientLog(
      LOG_CHANNEL,
      JSON.stringify({
        kind: "slow-interaction",
        verdict,
        durationMs: payload.durationMs,
        ownMs: Math.round(ownMs),
        target,
        breakdown: a.breakdown,
        forcedBy: a.forcedBy,
      }),
    );
    void fileSlowInteraction(payload, verdict);
  };

  let eventObserver: PerformanceObserver | null = null;
  if (eventTimingSupported()) {
    eventObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as EventTimingEntry[]) {
        if (e.interactionId === 0 || judged.includes(e.interactionId)) continue;
        // Its own time: an input delay alone is the long task it waited on.
        const end = e.startTime + e.duration;
        if (end - e.processingStart < INTERACTION.RECORD_MIN_MS) continue;
        slow.push({ start: e.processingStart, end });
        const group = pending.get(e.interactionId);
        if (group) {
          group.entries.push(e);
          group.origin ??= originOf(e);
        } else {
          pending.set(e.interactionId, { entries: [e], origin: originOf(e) });
          const id = e.interactionId;
          after(INTERACTION.GRACE_MS, () => judge(id));
        }
      }
    });
    eventObserver.observe({
      type: EVENT_ENTRY_TYPE,
      durationThreshold: INTERACTION.RECORD_MIN_MS,
      buffered: false,
    } as PerformanceObserverInit);
    for (const type of Object.keys(DISPATCHED))
      window.addEventListener(type, onDispatch, {
        capture: true,
        passive: true,
      });
  } else {
    clientLog(
      LOG_CHANNEL,
      JSON.stringify({
        kind: "no-event-timing",
        reason: "Event Timing unsupported: slow interactions go unmeasured",
      }),
    );
  }

  return {
    onFrame(e) {
      const end = e.startTime + e.duration;
      frames.push({
        start: e.startTime,
        end,
        styleAndLayoutStart: e.styleAndLayoutStart,
        scripts: e.scripts.map((s) => {
          const fn = s.sourceFunctionName || "(anonymous)";
          return {
            start: s.startTime,
            duration: s.duration,
            forced: s.forcedStyleAndLayoutDuration,
            label: s.invoker ? `${fn} (${s.invoker})` : fn,
          };
        }),
        frame: toStallFrame(e),
      });
      prune(end);
    },
    deferSlowFrame(frame, file) {
      const start = frame.startedAt - performance.timeOrigin;
      const w = { start, end: start + frame.durationMs };
      after(INTERACTION.GRACE_MS, () => {
        if (!frameClaimed(w, slow)) file();
      });
    },
    dispose() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      eventObserver?.disconnect();
      if (eventObserver)
        for (const type of Object.keys(DISPATCHED))
          window.removeEventListener(type, onDispatch, { capture: true });
    },
  };
}
