import { useEffect, useSyncExternalStore } from "react";
import { navigate } from "@plugins/apps-core/plugins/tabs/web";
import type {
  GestureAdvance,
  Hint,
  Tour,
  TourControl,
  TourEndOutcome,
  TourTrigger,
} from "../../core";
import {
  pointerEndCallback,
  type PointAtOptions,
  type PointerEnd,
  type PointerRun,
} from "./pointer";
import {
  emptyTipQueue,
  removeTip,
  requestTip,
  stepTips,
  type TipQueue,
} from "./tip-queue";
import {
  beginTour,
  primaryMove,
  transitionTour,
  type PrimaryPress,
  type AnyTour,
  type TourEvent,
  type TourRun,
} from "./tour-machine";

/**
 * The engine's page-global state: the tip queue, the running tour, and what
 * was answered this session. Module-level because its writers are anywhere —
 * `useHintMoment` in any component, `startTour` from the help menu, the
 * Esc / ← / → shortcuts — while its one reader and effect-runner is the
 * `HintHost` at `Core.Root`, outside every tab.
 */
interface EngineState {
  readonly tips: TipQueue;
  readonly tour: TourRun | null;
  /** A `startTour(id)` the host has not resolved against the registry yet. */
  readonly requestedTour: string | null;
  /** The one-off spotlight `pointAt` put up — never while a tour runs. */
  readonly pointer: PointerRun | null;
}

const initialState: EngineState = {
  tips: emptyTipQueue,
  tour: null,
  requestedTour: null,
  pointer: null,
};
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: one hint engine per page; its writers (moments in any surface, the help menu, global shortcuts) live outside any one surface tree
let state = initialState;
const listeners = new Set<() => void>();
/**
 * Hints and tours answered (or started) this session. The seen row lands
 * through the live collection a moment later; until then this keeps the same
 * tip from showing twice, and keeps a tour that failed to record (a read-only
 * main) from restarting.
 */
const answered = new Set<string>();
/** How many mounted components hold each hint's moment (see `useHintMoment`). */
const momentHolders = new Map<string, number>();

function set(next: EngineState): void {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

/** Writes the tip queue — a no-op transition (same value) notifies nobody. */
function setTips(tips: TipQueue): void {
  if (tips !== state.tips) set({ ...state, tips });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useEngineState(): EngineState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

// ── Tips ────────────────────────────────────────────────────────────────

/**
 * Asks to show `hint` while `when` holds. The host shows it once its seen state
 * is known and unseen, its anchor is on the page and no tour runs — after the
 * settle window, lowest `order` first, one at a time. `when` turning false (or
 * the component unmounting) withdraws it without marking it seen.
 *
 * Several components may hold one hint's moment (every chip of a kind): the
 * request stays while ANY holds it, and is withdrawn when the last lets go.
 * `hint` may be absent — a generic component handed an optional tip asks nothing.
 */
export function useHintMoment(
  hint: Hint | null | undefined,
  when: boolean,
): void {
  useEffect(() => {
    if (!hint || !when) return;
    const holders = momentHolders.get(hint.id) ?? 0;
    momentHolders.set(hint.id, holders + 1);
    if (holders === 0) setTips(requestTip(state.tips, hint, Date.now()));
    return () => {
      const left = (momentHolders.get(hint.id) ?? 1) - 1;
      if (left > 0) {
        momentHolders.set(hint.id, left);
        return;
      }
      momentHolders.delete(hint.id);
      setTips(removeTip(state.tips, hint.id, Date.now()));
    };
  }, [hint, when]);
}

/** The host advances the queue at `now` against what is eligible. */
export function stepTipQueue(
  now: number,
  eligible: (hint: Hint) => boolean,
): void {
  setTips(stepTips(state.tips, now, eligible));
}

/** The active tip was answered (Got it / × / acted on): it leaves the queue for the session. */
export function answerTip(id: string): void {
  answered.add(id);
  setTips(removeTip(state.tips, id, Date.now()));
}

export function isAnswered(id: string): boolean {
  return answered.has(id);
}

/** `resetHints` brings these ids back: forget that they were answered this session. */
export function forgetAnswered(ids: readonly string[]): void {
  for (const id of ids) answered.delete(id);
}

// ── Tours ───────────────────────────────────────────────────────────────

export type TourEffect =
  | { readonly type: "started"; readonly tour: AnyTour }
  | {
      readonly type: "ended";
      readonly tour: AnyTour;
      readonly outcome: TourEndOutcome;
    };

const effectListeners = new Set<(effect: TourEffect) => void>();

/** The host's single subscription to tour starts and ends — the ONE exit path. */
export function subscribeTourEffects(
  cb: (effect: TourEffect) => void,
): () => void {
  effectListeners.add(cb);
  return () => effectListeners.delete(cb);
}

function emit(effect: TourEffect): void {
  for (const l of effectListeners) l(effect);
}

/**
 * Starts the tour declared with `id` (a `Hints.Tour` contribution). If its app
 * is not the focused one, the host navigates there first. A tour already
 * running ends as `dismissed` (through the exit path) before this one starts.
 */
export function startTour(id: string): void {
  set({ ...state, requestedTour: id });
}

/** The host resolved a requested id (or an autoStart) to its declaration. */
export function runTour(tour: AnyTour): void {
  if (state.tour) dispatchTour({ type: "end", outcome: "dismissed" });
  answered.add(tour.id);
  // A tour supersedes a one-off spotlight: it closes, its callbacks unrun.
  set({ ...state, tour: beginTour(tour), requestedTour: null, pointer: null });
  emit({ type: "started", tour });
}

export function clearTourRequest(): void {
  if (state.requestedTour !== null) set({ ...state, requestedTour: null });
}

/** Where `tour` stands while it runs — `null` when it (or no tour) is not running. */
export interface TourRunView<D> {
  readonly phase: "intro" | "step";
  readonly stepId: string;
  readonly data: D;
}

/**
 * Reads `tour`'s progress while it is the running tour. For a plugin that
 * feeds the tour data only the page knows (the handoff step's conversation,
 * resolved from the task the tour filed): mount a component that reads this,
 * subscribes to its own data only on the steps that need it, and writes with
 * {@link setTourData}.
 */
export function useTourRun<D extends object>(
  tour: Tour<D>,
): TourRunView<D> | null {
  const run = useSyncExternalStore(
    subscribe,
    () => state.tour,
    () => state.tour,
  );
  if (run?.tour.id !== tour.id) return null;
  // The run holds the data `tour`'s own steps wrote, from its `initialData`.
  return { phase: run.phase, stepId: run.stepId, data: run.data as D };
}

/**
 * Updates `tour`'s data while it runs (a no-op otherwise) — the outside-the-
 * steps twin of `ctl.setData`. A step's copy, labels and anchor function
 * re-read it.
 */
export function setTourData<D extends object>(
  tour: Tour<D>,
  update: Partial<D> | ((data: D) => D),
): void {
  if (state.tour?.tour.id !== tour.id) return;
  dispatchTour({
    type: "set-data",
    update: update as object | ((data: object) => object),
  });
}

export function isTourRunning(): boolean {
  return state.tour !== null;
}

export function dispatchTour(event: TourEvent): void {
  const run = state.tour;
  if (!run) return;
  const t = transitionTour(run, event);
  set({ ...state, tour: t.run });
  if (t.exit) emit({ type: "ended", tour: run.tour, outcome: t.exit });
}

/** The `ctl` a step's `next.run` drives the tour with. */
function controlFor(run: TourRun, via: TourTrigger): TourControl<object> {
  return {
    via,
    go: (stepId) => dispatchTour({ type: "go", stepId }),
    next: () => dispatchTour({ type: "next" }),
    end: (outcome = "completed") => dispatchTour({ type: "end", outcome }),
    data: run.data,
    setData: (update) => dispatchTour({ type: "set-data", update }),
    navigate: (url) => navigate(url),
  };
}

function press(how: PrimaryPress): void {
  const run = state.tour;
  if (!run) return;
  const move = primaryMove(run, how);
  if (move === null) return;
  if (move.kind === "event") dispatchTour(move.event);
  else move.run(controlFor(run, move.via));
}

/** The current step's primary button: its `run`, or the default move. */
export function pressPrimary(): void {
  press({ by: "button" });
}

/** → : the primary button, unless the step waits on its `advanceOn` alone. */
export function pressNextKey(): void {
  press({ by: "key" });
}

/**
 * The user made `gesture` on the current step's anchor (its own handler has
 * run): on a step whose `advanceOn` is that gesture, they did the primary
 * themselves — the same move as the button, with `ctl.via === "anchor"`.
 */
export function actOnAnchor(gesture: GestureAdvance): void {
  press({ by: "gesture", gesture });
}

// ── pointAt: a one-off spotlight ────────────────────────────────────────

let pointerSeq = 0;

/**
 * Spotlights the element `target()` returns — a hole on it and a caption card
 * beside it (`body`; Back when `onBack`, Next when `onNext`, else Done; dots
 * when `step`) — drawn by the same stage as tours and tracked the same way.
 * No declared anchor, no seen state: the caller has already found the element
 * (`resolveUiContext`, a ref).
 *
 * `target` is called once, now. Fails loudly rather than spotlighting nothing
 * or something else: it throws when `target()` returns null (resolve first),
 * when it is not an `HTMLElement`, and while a tour runs (the tour owns the
 * stage; a spotlight over its step would draw a second card on top of it).
 *
 * A second call replaces the first (its callbacks unrun). It ends on Back
 * (`onBack`), Next or a click on the spotlit element (`onNext`), and Done / × /
 * Esc / the element leaving the page (no callback). It closes BEFORE the
 * callback runs, so a callback may `pointAt` the next element. A tour starting
 * closes it.
 */
export function pointAt(
  target: () => Element | null,
  opts: PointAtOptions,
): void {
  if (state.tour)
    throw new Error(
      `pointAt: the "${state.tour.tour.id}" tour is running — it owns the stage; end it first`,
    );
  const el = target();
  if (el === null)
    throw new Error(
      "pointAt: target() returned null — resolve the element before pointing at it",
    );
  if (!(el instanceof HTMLElement))
    throw new Error(
      `pointAt: target() returned a <${el.tagName.toLowerCase()}>, not an HTMLElement`,
    );
  set({ ...state, pointer: { id: ++pointerSeq, el, opts } });
}

/** Ends the spotlight (a no-op when none is up), then runs that end's callback. */
export function endPointer(how: PointerEnd): void {
  const pointer = state.pointer;
  if (!pointer) return;
  set({ ...state, pointer: null });
  pointerEndCallback(pointer.opts, how)?.();
}

export function isPointing(): boolean {
  return state.pointer !== null;
}
