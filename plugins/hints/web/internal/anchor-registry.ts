import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useReportPopupOpen } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import { targetKey, type HintTarget } from "../../core";

/**
 * The page's anchor registry: every element a `useHintAnchor` ref is attached
 * to, keyed by its target key, plus the two things the host says about a key —
 * HELD (a tip or a step is on it, or it pulses) and PULSING (a tour just ended
 * and points at it). Push-based: elements register through their ref, readers
 * subscribe; no selector, no polling, no MutationObserver.
 *
 * Several elements may register one key at once (a keep-alive tab renders a
 * hidden copy of a row; the action bar has two mutually-exclusive hosts), so a
 * key holds a list and {@link resolveAnchorElement} picks the newest one that
 * is actually rendered.
 */
// Page-global by design: one hint host per page reads the anchors every
// surface registers (a tour crosses apps and tabs).
const elements = new Map<string, HTMLElement[]>();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: one hint host per page reads the anchors every surface registers (a tour crosses apps and tabs), so what it holds cannot be a per-surface scoped store
let held: ReadonlySet<string> = new Set();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design (see `elements`): what the one host pulses
let pulsing: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeAnchors(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Whether each registered element was rendered when last looked at — so a
 * box change that does not flip it (an ordinary resize) notifies nobody.
 */
const lastRendered = new WeakMap<HTMLElement, boolean>();

/**
 * A registered element's box changed (`useHintAnchor` watches it through the
 * element-size primitive's ResizeObserver): notify when that flipped whether
 * it is rendered. Registration alone cannot see it — the element never
 * re-registers — yet it is how a popover kept mounted while closed (Improve's
 * draft form: registered once, then `display: none` / shown on every close /
 * open), a folded toolbar panel or a keep-alive tab's copy appears and
 * leaves. A `display` change on the element or any ancestor moves its box
 * between zero and its size, which is exactly what a ResizeObserver reports.
 * (A `visibility: hidden` flip keeps the box and is not seen — no registered
 * anchor's owner hides that way.)
 */
function recheckRendered(el: HTMLElement): void {
  const now = isRendered(el);
  if (lastRendered.get(el) === now) return;
  lastRendered.set(el, now);
  notify();
}

function registerAnchor(key: string, el: HTMLElement): () => void {
  elements.set(key, [...(elements.get(key) ?? []), el]);
  lastRendered.set(el, isRendered(el));
  notify();
  return () => {
    const rest = (elements.get(key) ?? []).filter((e) => e !== el);
    if (rest.length > 0) elements.set(key, rest);
    else elements.delete(key);
    notify();
  };
}

function isRendered(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  return el.checkVisibility({ visibilityProperty: true });
}

/** The newest rendered element registered under `key`, or null when none is on the page. */
export function resolveAnchorElement(key: string): HTMLElement | null {
  const list = elements.get(key);
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const el = list[i]!;
    if (isRendered(el)) return el;
  }
  return null;
}

/** The host declares which keys a tip or a step is on (the anchor and any cue). */
export function setHeldAnchors(keys: readonly string[]): void {
  const next = new Set(keys);
  if (next.size === held.size && [...next].every((k) => held.has(k))) return;
  held = next;
  notify();
}

/** Pulses `key` for `ms` (held open meanwhile) — the tour-exit pointer at `?`. */
export function pulseAnchor(key: string, ms: number): void {
  pulsing = new Set([...pulsing, key]);
  notify();
  // One timer per pulse: the pulse IS a timed state (it ends on its own), not
  // a poll for a change.
  setTimeout(() => {
    pulsing = new Set([...pulsing].filter((k) => k !== key));
    notify();
  }, ms);
}

/**
 * Registers the element it is attached to as `target`'s anchor and returns
 * the callback ref. While a tip or a tour step is on it — or it pulses after a
 * tour — it reports itself as an open popup to its enclosing
 * `PopupOpenScope`, so an anchor inside the floating action bar holds the bar
 * unfolded through the same counted signal the bar's own popups use.
 *
 * `target` is a plain anchor or `family.at(params)`; a new key re-registers.
 * `null` / `undefined` registers nothing — for a generic component handed an
 * optional anchor by its host (the task-draft form's `hintAnchors`), so the
 * hook is still called unconditionally.
 */
export function useHintAnchor(
  target: HintTarget | null | undefined,
): (el: HTMLElement | null) => void {
  const key = target ? targetKey(target) : null;
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(
    () => (el && key !== null ? registerAnchor(key, el) : undefined),
    [key, el],
  );
  // Shown / hidden in place (a kept-mounted popover opening): see `recheckRendered`.
  useResizeObserver(
    () => (key === null ? null : el),
    () => {
      if (el && key !== null) recheckRendered(el);
    },
    { deps: [el, key] },
  );
  const isHeld = useSyncExternalStore(
    subscribeAnchors,
    () => key !== null && (held.has(key) || pulsing.has(key)),
    () => false,
  );
  useReportPopupOpen(isHeld);
  return useCallback((node: HTMLElement | null) => setEl(node), []);
}

/**
 * Whether `target` is pulsing right now — the anchor's owner draws it (the `?`
 * button's ring after a tour ends). The hold is already applied by
 * {@link useHintAnchor}.
 */
export function useHintAnchorPulse(target: HintTarget): boolean {
  const key = targetKey(target);
  return useSyncExternalStore(
    subscribeAnchors,
    () => pulsing.has(key),
    () => false,
  );
}
