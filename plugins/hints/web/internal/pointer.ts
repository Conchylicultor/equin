/**
 * `pointAt`'s model: a one-off spotlight on an element the caller already
 * resolved — no declared anchor, no seen state. The store half lives in
 * `engine-store.ts` beside the tour it must not overlap; this file is the pure
 * part the host draws from.
 */

export interface PointAtOptions {
  /** The caption beside the spotlit element. */
  readonly body: string;
  /** Shows Back; called when it is pressed (the spotlight has closed). */
  readonly onBack?: () => void;
  /**
   * Shows Next (else Done); called when it is pressed or the spotlit element
   * is clicked (the spotlight has closed first, so it may `pointAt` again).
   */
  readonly onNext?: () => void;
  /** Progress dots, for a caller stepping through several spotlights. */
  readonly step?: { readonly index: number; readonly total: number };
}

/** The spotlight on screen: `id` is one showing (a replacing call is a new id). */
export interface PointerRun {
  readonly id: number;
  readonly el: HTMLElement;
  readonly opts: PointAtOptions;
}

/** How a spotlight ends: its primary (`next`), Back, or closed (×, Esc, Done, the element leaving). */
export type PointerEnd = "next" | "back" | "close";

/** What the spotlight's caption card shows, derived from its options. */
export interface PointerCard {
  readonly steps?: { readonly count: number; readonly index: number };
  readonly back: boolean;
  readonly primary: {
    readonly label: "Next" | "Done";
    readonly end: PointerEnd;
  };
}

export function pointerCard(opts: PointAtOptions): PointerCard {
  return {
    ...(opts.step
      ? { steps: { count: opts.step.total, index: opts.step.index } }
      : {}),
    back: opts.onBack !== undefined,
    primary: opts.onNext
      ? { label: "Next", end: "next" }
      : { label: "Done", end: "close" },
  };
}

/** The callback an end runs, if any. */
export function pointerEndCallback(
  opts: PointAtOptions,
  how: PointerEnd,
): (() => void) | undefined {
  if (how === "next") return opts.onNext;
  if (how === "back") return opts.onBack;
  return undefined;
}
