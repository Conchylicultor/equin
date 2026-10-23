import {
  resolveStepAdvance,
  type GestureAdvance,
  type Tour,
  type TourControl,
  type TourEndOutcome,
  type TourStep,
  type TourTrigger,
} from "../../core";

/**
 * One running tour, as a pure value. `phase` is the welcome card (`intro`) or
 * a step; `history` is the steps already left, for Back; `anchorShown` is
 * whether the current step's anchor has been on the page since the step
 * began — a step only treats its anchor as LOST once it has seen it (the
 * handoff step's row may not exist yet when the step starts).
 */
// A tour's data type is contravariant in its copy functions, so a registry of
// tours of different shapes can only be held erased; the machine never reads
// the data itself.
export type AnyTour = Tour<any>;

export interface TourRun {
  readonly tour: AnyTour;
  readonly phase: "intro" | "step";
  readonly stepId: string;
  readonly data: object;
  readonly history: readonly string[];
  readonly anchorShown: boolean;
}

export type TourEvent =
  | { readonly type: "begin" }
  | { readonly type: "next" }
  | { readonly type: "back" }
  | { readonly type: "go"; readonly stepId: string }
  | { readonly type: "alt" }
  | { readonly type: "end"; readonly outcome: TourEndOutcome }
  | { readonly type: "anchor-shown" }
  | { readonly type: "anchor-lost" }
  | { readonly type: "signal"; readonly id: string; readonly payload: unknown }
  | {
      readonly type: "set-data";
      readonly update: object | ((data: object) => object);
    };

/**
 * A transition's result: the next run (null once the tour is over) and, on
 * every path that ends it, the `exit` outcome — the ONE place a tour end is
 * reported, whether by finishing, ×, Esc, or "I'll explore on my own".
 */
export interface TourTransition {
  readonly run: TourRun | null;
  readonly exit?: TourEndOutcome;
}

export function beginTour(tour: AnyTour): TourRun {
  const first = tour.steps[0];
  return {
    tour,
    phase: tour.intro ? "intro" : "step",
    stepId: first.id,
    data: tour.initialData,
    history: [],
    anchorShown: false,
  };
}

export function currentStep(run: TourRun): TourStep<object> {
  const step = run.tour.steps.find((s) => s.id === run.stepId);
  if (!step)
    throw new Error(`tour "${run.tour.id}" has no step "${run.stepId}"`);
  return step;
}

/** 0-based position of the current step, for the step dots. */
export function stepIndex(run: TourRun): number {
  return run.tour.steps.findIndex((s) => s.id === run.stepId);
}

/** Whether the current step offers Back: its own `back`, else a step to return to. */
export function canGoBack(run: TourRun): boolean {
  const back = currentStep(run).back;
  if (back === null) return false;
  return back !== undefined || run.history.length > 0;
}

export function isLastStep(run: TourRun): boolean {
  return stepIndex(run) === run.tour.steps.length - 1;
}

function goTo(run: TourRun, stepId: string, remember: boolean): TourTransition {
  return {
    run: {
      ...run,
      phase: "step",
      stepId,
      history: remember ? [...run.history, run.stepId] : run.history,
      anchorShown: false,
    },
  };
}

function advance(run: TourRun): TourTransition {
  const index = stepIndex(run);
  const following = run.tour.steps[index + 1];
  if (!following) return { run: null, exit: "completed" };
  return goTo(run, following.id, true);
}

function signalMatches(step: TourStep<object>, data: object, id: string) {
  const on = resolveStepAdvance(step, data);
  if (on === null || typeof on !== "object") return null;
  if ("signal" in on) return on.signal.id === id ? on : null;
  return on.id === id ? { signal: on } : null;
}

export function transitionTour(run: TourRun, event: TourEvent): TourTransition {
  if (event.type === "end") return { run: null, exit: event.outcome };
  if (event.type === "set-data") {
    const data =
      typeof event.update === "function"
        ? event.update(run.data)
        : { ...run.data, ...event.update };
    return { run: { ...run, data } };
  }
  if (run.phase === "intro") {
    if (event.type === "begin" || event.type === "next") {
      return { run: { ...run, phase: "step" } };
    }
    return { run };
  }
  const step = currentStep(run);
  switch (event.type) {
    case "begin":
      return { run };
    case "next":
      return advance(run);
    case "back": {
      if (step.back === null) return { run };
      if (step.back !== undefined) {
        // Rewind the history to before the target's last visit, so Back from
        // there continues the story from where it first reached it.
        const at = run.history.lastIndexOf(step.back);
        return {
          run: {
            ...run,
            stepId: step.back,
            history: at >= 0 ? run.history.slice(0, at) : run.history,
            anchorShown: false,
          },
        };
      }
      const previous = run.history.at(-1);
      if (previous === undefined) return { run };
      return {
        run: {
          ...run,
          stepId: previous,
          history: run.history.slice(0, -1),
          anchorShown: false,
        },
      };
    }
    case "go":
      return goTo(run, event.stepId, true);
    case "alt":
      return step.alt ? goTo(run, step.alt.to, true) : { run };
    case "anchor-shown":
      return run.anchorShown ? { run } : { run: { ...run, anchorShown: true } };
    case "anchor-lost":
      if (!run.anchorShown) return { run };
      // A lost anchor steps BACK in the story (the panel closed unsent → the
      // Improve step again), so it is not remembered as a step to return to.
      if (step.onAnchorLost) return goTo(run, step.onAnchorLost, false);
      return { run: { ...run, anchorShown: false } };
    case "signal": {
      const match = signalMatches(step, run.data, event.id);
      if (!match) return { run };
      const updated =
        "update" in match && match.update
          ? { ...run, data: match.update(run.data, event.payload) }
          : run;
      return "to" in match && match.to
        ? goTo(updated, match.to, true)
        : advance(updated);
    }
  }
}

/**
 * What presses the primary: the card's button, the → key, or the user's
 * gesture on the anchor (the step's `advanceOn` "anchor-click" /
 * "anchor-hover", reported after the anchor's own handler ran).
 */
export type PrimaryPress =
  | { readonly by: "button" }
  | { readonly by: "key" }
  | { readonly by: "gesture"; readonly gesture: GestureAdvance };

/**
 * What a press of the primary does on `run`: nothing (`null`), a machine
 * event (the intro's begin, a step's default move), or the step's `next.run`
 * with who triggered it. A gesture is the user doing the primary themselves,
 * so it is the same move as the button — `run` included — but only on a step
 * whose `advanceOn` is that gesture, and with `via: "anchor"` so a `run`
 * skips what the anchor already did. → stands down on a `next: "none"` step
 * (it waits on its `advanceOn` alone).
 */
export type PrimaryMove =
  | { readonly kind: "event"; readonly event: TourEvent }
  | {
      readonly kind: "run";
      readonly run: (ctl: TourControl<object>) => void;
      readonly via: TourTrigger;
    }
  | null;

export function primaryMove(run: TourRun, press: PrimaryPress): PrimaryMove {
  if (run.phase === "intro")
    return press.by === "gesture"
      ? null
      : { kind: "event", event: { type: "begin" } };
  const step = currentStep(run);
  if (press.by === "key" && step.next === "none") return null;
  if (
    press.by === "gesture" &&
    resolveStepAdvance(step, run.data) !== press.gesture
  )
    return null;
  const via: TourTrigger = press.by === "gesture" ? "anchor" : "button";
  if (typeof step.next === "object" && step.next.run)
    return { kind: "run", run: step.next.run, via };
  return { kind: "event", event: { type: "next" } };
}
