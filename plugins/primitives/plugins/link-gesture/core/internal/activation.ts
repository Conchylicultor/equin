/**
 * A link as DATA: where a plain click goes (`open`) and the URL a ⌘/Ctrl- or
 * middle-click opens in a new browser tab instead (`href`). The web barrel's
 * `linkProps(target)` turns it into a control's gesture handlers.
 *
 * Data rather than handlers because not every activation is a mouse click: a
 * focused row's Enter, or a list activating a row it just created, has no
 * gesture to read and simply runs `open()`. `href` is a thunk, evaluated only
 * for an "elsewhere" gesture and synchronously inside it (so `window.open` is
 * still a user gesture); it returns an app path (`/agents/c/42`).
 */
export interface LinkTarget {
  /**
   * Open it here. `gesture` is REQUIRED so a wrapper that forwards a link
   * (a toggle, `afterOpen`, a row activation) cannot drop it: a wrapper that
   * calls `open()` bare is a type error, not a silently lost ⌥-click.
   */
  open(gesture: Gesture): void;
  href(): string;
}

/**
 * How the user asked to open (or close) something HERE — the modifiers that
 * do not send it elsewhere. Read off the event by `gestureOf` (web barrel);
 * {@link PLAIN_GESTURE} for an activation with no modifiers to read.
 *
 * `keepOthers` (⌥/Alt): keep what is already on screen — a pane open inserts
 * beside the caller instead of replacing what stands right of it, a pane close
 * removes only that pane.
 */
export interface Gesture {
  keepOthers: boolean;
}

/** The gesture of an activation with no modifiers (a plain click, an open run after a mutation). */
export const PLAIN_GESTURE: Gesture = Object.freeze({ keepOthers: false });

/**
 * A plain action: a function that returns NOTHING. Spelled `void | undefined`,
 * not `void`, on purpose — TypeScript ignores the return of a function assigned
 * to a `() => void` type, so `() => openPane.to(…)` would be accepted there and
 * the `LinkTarget` it builds silently dropped on click. A return type that is
 * not exactly `void` is checked for real: a function returning a value (a
 * `LinkTarget`, a Promise) is a type error, while one returning `void` — a
 * setter call, a `() => void` binding, a block body — still fits.
 */
export type Action = () => void | undefined;

/**
 * What activating something does: a plain {@link Action}, or a
 * {@link LinkTarget} whose "elsewhere" gestures open a browser tab. Switched on
 * in one place — the web barrel's `activationProps` / `runActivation`.
 */
export type Activation = Action | LinkTarget;

/**
 * Run an activation the way a click (or Enter) does, with that input's
 * {@link Gesture} — {@link PLAIN_GESTURE} when there is none to read.
 */
export function runActivation(activation: Activation, gesture: Gesture): void {
  if (typeof activation === "function") activation();
  else activation.open(gesture);
}

/** The URL an "elsewhere" gesture opens, or `undefined` for a plain action. */
export function activationHref(
  activation: Activation | undefined,
): (() => string) | undefined {
  if (activation === undefined || typeof activation === "function") {
    return undefined;
  }
  return () => activation.href();
}

/**
 * The same activation with `effect` run after its plain open (closing the
 * popover a pick was made in). A link stays a link with the same `href`: an
 * "elsewhere" gesture leaves this tab — and so its popover — where it is.
 */
export function afterOpen(
  activation: Activation,
  effect: () => void,
): Activation {
  if (typeof activation === "function") {
    return () => {
      activation();
      effect();
    };
  }
  return {
    open: (gesture) => {
      activation.open(gesture);
      effect();
    },
    href: () => activation.href(),
  };
}

/**
 * The same activation with `effect` run just BEFORE its plain open — for a
 * record the destination's first render must already see (which list the pick
 * was made in). A link stays a link with the same `href`; an "elsewhere"
 * gesture does not run `effect`, since this tab does not navigate.
 */
export function beforeOpen(
  activation: Activation,
  effect: () => void,
): Activation {
  if (typeof activation === "function") {
    return () => {
      effect();
      activation();
    };
  }
  return {
    open: (gesture) => {
      effect();
      activation.open(gesture);
    },
    href: () => activation.href(),
  };
}
