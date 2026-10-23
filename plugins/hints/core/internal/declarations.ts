import type { ReactNode } from "react";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { HintTarget } from "./anchors";
import type { HintSignal } from "./signals";

/** Which side of its anchor a card prefers (it flips on collision). */
export type HintPlacement = "top" | "right" | "bottom" | "left";

/**
 * A tip's or a step's copy. Rich content is a `ReactNode` (a `<b>`, a
 * `<kbd>`): declarations are data the web host renders, and `core/` may name
 * React's types (never its runtime). A tour's copy may read the tour's data —
 * `(data) => …` — so a step can say "Your request is ready" only once one was
 * sent.
 */
export type HintContent<D> = ReactNode | ((data: D) => ReactNode);

/** A button label, optionally read from the tour's data. */
export type HintLabel<D> = string | ((data: D) => string);

/** A contextual tip: shown once, at its moment, on one anchor. */
export interface Hint {
  readonly kind: "hint";
  /** Unique across every hint and tour — it is the seen row's id. */
  readonly id: string;
  readonly anchor: HintTarget;
  readonly title: ReactNode;
  readonly body: ReactNode;
  readonly placement?: HintPlacement;
  /**
   * Lower shows first when several tips' moments come together (the order the
   * user would use them in). Default 0; ties go to whichever asked first.
   */
  readonly order?: number;
  /** The dismiss button's label. Default "Got it". */
  readonly gotIt?: string;
}

export function defineHint(def: Omit<Hint, "kind">): Hint {
  if (def.id.length === 0) throw new Error("defineHint: empty id");
  return Object.freeze({ kind: "hint", ...def });
}

/** How a tour ended — the seen row's outcome. */
export type TourEndOutcome = "completed" | "skipped" | "dismissed";

/**
 * Who performed a step's primary action: the card's button (or →), or the
 * user acting on the step's anchor with its `advanceOn` gesture — the user did
 * the primary themselves, and the anchor's own handler has already run.
 */
export type TourTrigger = "button" | "anchor";

/**
 * What a step's `next.run` (and nothing else) drives the tour with. `data` is
 * the tour's data as of this call; `setData` merges a patch or applies an
 * updater. `navigate` is the cross-app tab navigation, so a step can take the
 * user to the app its next anchor lives in. `via` says who performed the
 * primary — a `run` whose action is the very thing the anchor does on its own
 * (opening the row the user just clicked) skips it on `"anchor"`.
 */
export interface TourControl<D> {
  readonly via: TourTrigger;
  go(stepId: string): void;
  next(): void;
  end(outcome?: TourEndOutcome): void;
  readonly data: D;
  setData(update: Partial<D> | ((data: D) => D)): void;
  navigate(url: string): void;
}

/**
 * A signal that advances a step, optionally folding its payload into the
 * tour's data and going somewhere other than the next step. Spelled with
 * {@link onSignal} so the payload type flows from the signal.
 */
export interface SignalAdvance<D, T> {
  readonly signal: HintSignal<T>;
  // Method syntax on purpose: it is checked bivariantly, so an advance built
  // by onSignal() for the data shape it infers fits the step's own `D`.
  update?(data: D, payload: T): D;
  readonly to?: string;
}

export function onSignal<D, T>(
  signal: HintSignal<T>,
  opts?: { update?: (data: D, payload: T) => D; to?: string },
): SignalAdvance<D, T> {
  return { signal, ...opts };
}

/** A gesture on the step's anchor that moves the tour on. */
export type GestureAdvance = "anchor-hover" | "anchor-click";

export type StepAdvance<D> =
  GestureAdvance | HintSignal<any> | SignalAdvance<D, any>;

export interface TourStep<D> {
  readonly id: string;
  /**
   * The element the step points at, or a function of the tour's data (the
   * handoff step's conversation row). `null` draws the card centered, with no
   * spotlight.
   */
  readonly anchor: HintTarget | null | ((data: D) => HintTarget | null);
  /** A second element to ring while the step shows (the Send button inside the anchored panel). */
  readonly cue?: HintTarget;
  readonly title: HintContent<D>;
  readonly body: HintContent<D>;
  /**
   * A quiet line at the card's foot, left of its buttons — how to act on the
   * target by hand ("Hover it to unfold", with its icon).
   */
  readonly footnote?: HintContent<D>;
  readonly placement?: HintPlacement;
  /**
   * Room the spotlight leaves around the anchor, in px (default 6). The
   * cut-out's corners follow the anchor's own, grown by this much, so a wide
   * region (the app gallery) can breathe without naming a radius.
   */
  readonly padding?: number;
  /**
   * The primary button. Default `{ label: "Next" }` ("Done" on the last
   * step); `run` replaces the default move — call `ctl.next()`, `ctl.go()` or
   * `ctl.end()` yourself. `"none"`: no primary button (the step waits on
   * `advanceOn`). A gesture `advanceOn` performs the primary too (`run` with
   * `ctl.via === "anchor"`, else the default move).
   */
  readonly next?:
    | {
        readonly label: HintLabel<D>;
        readonly run?: (ctl: TourControl<D>) => void;
      }
    | "none";
  /** A secondary button that jumps to another step (e.g. Skip). */
  readonly alt?: { readonly label: HintLabel<D>; readonly to: string };
  /**
   * Where Back goes. Default: the step the tour came from (Back shows once
   * there is one). A step id jumps back to that step — the history is rewound
   * to before its last visit, so the story does not loop (the Agent Manager
   * step backs to Improve, past the closed Improve panel). `null`: no Back
   * (a step in another app, whose previous anchor is not on this page).
   */
  readonly back?: string | null;
  /**
   * What moves the tour on besides the primary button. A gesture
   * (`"anchor-click"`, `"anchor-hover"`) means the user did the primary
   * themselves, on the target: it runs `next.run` with `ctl.via === "anchor"`
   * (else the default move), after the anchor's own handler. A gesture may depend on
   * the tour's data — `(data) => GestureAdvance | null` — for an anchor whose
   * gesture only means something in some states (hovering the toolbar unfolds
   * it while it floats; docked, it is already open, so only Next moves on).
   */
  readonly advanceOn?: StepAdvance<D> | ((data: D) => GestureAdvance | null);
  /**
   * Where to go when the anchor, once shown, leaves the page (the Improve
   * panel closed without sending → back to the Improve step). Without it the
   * card simply waits for the anchor to come back.
   */
  readonly onAnchorLost?: string;
  /** `dim` (default) draws the spotlight scrim; `none` only rings the anchor. */
  readonly scrim?: "dim" | "none";
}

/** The welcome card a tour can open with. */
export interface TourIntro<D> {
  /** The mark above the title, drawn on the welcome card's brand tile. */
  readonly icon?: IconRef;
  readonly title: HintContent<D>;
  readonly body: HintContent<D>;
  /** A small line under the buttons ("A few quick stops · about a minute"). */
  readonly note?: HintContent<D>;
  /** Default "Show me around". */
  readonly start?: string;
  /** Default "I'll explore on my own" — ends the tour as `skipped`. */
  readonly skip?: string;
}

export interface Tour<D extends object = Record<string, never>> {
  readonly kind: "tour";
  /** Unique across every hint and tour — it is the seen row's id. */
  readonly id: string;
  /** The app the tour starts in (`autoStart` waits for it to be focused). */
  readonly app: AppRef;
  /** The help menu's "Replay the tour" starts the primary tour. */
  readonly primary?: boolean;
  /** Start once, the first time `app` is focused while the tour is unseen. */
  readonly autoStart?: boolean;
  readonly intro?: TourIntro<D>;
  readonly initialData: D;
  readonly steps: readonly [TourStep<D>, ...TourStep<D>[]];
}

/** Every step id a tour names — `alt.to`, `onAnchorLost`, `back`, a signal's `to` — must exist. */
export function defineTour<D extends object = Record<string, never>>(
  def: Omit<Tour<D>, "kind">,
): Tour<D> {
  const ids = new Set<string>();
  for (const step of def.steps) {
    if (ids.has(step.id)) {
      throw new Error(
        `defineTour("${def.id}"): step "${step.id}" is declared twice`,
      );
    }
    ids.add(step.id);
  }
  const named = (from: string, to: string | undefined) => {
    if (to !== undefined && !ids.has(to)) {
      throw new Error(
        `defineTour("${def.id}"): step "${from}" names "${to}", which is not a step of the tour`,
      );
    }
  };
  for (const step of def.steps) {
    named(step.id, step.alt?.to);
    named(step.id, step.onAnchorLost);
    named(step.id, step.back ?? undefined);
    const advance = step.advanceOn;
    if (typeof advance === "object" && "signal" in advance)
      named(step.id, advance.to);
  }
  return Object.freeze({ kind: "tour", ...def });
}

/** Resolves a step's copy against the tour's data. */
export function resolveContent<D>(content: HintContent<D>, data: D): ReactNode {
  return typeof content === "function" ? content(data) : content;
}

/** Resolves a button label against the tour's data. */
export function resolveLabel<D>(label: HintLabel<D>, data: D): string {
  return typeof label === "function" ? label(data) : label;
}

/** Resolves a step's anchor against the tour's data. */
export function resolveStepAnchor<D>(
  step: TourStep<D>,
  data: D,
): HintTarget | null {
  return typeof step.anchor === "function" ? step.anchor(data) : step.anchor;
}

/** Resolves a step's `advanceOn` against the tour's data. */
export function resolveStepAdvance<D>(
  step: TourStep<D>,
  data: D,
): StepAdvance<D> | null {
  const on = step.advanceOn;
  if (on === undefined) return null;
  return typeof on === "function" ? on(data) : on;
}
