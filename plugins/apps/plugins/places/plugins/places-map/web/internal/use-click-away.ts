import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";

/** How far a press may travel and still be a click — further is a drag (a map pan). */
const CLICK_SLOP_PX = 5;

/**
 * Click-away dismissal for a non-modal panel floating over a surface (the
 * place card over the map): while `active`, a click anywhere in `region`
 * outside every one of `panels` (the card, and any companion it lives beside
 * — the docked thread whose picks it shows) calls `onDismiss` — except
 *
 * - a drag: the press travelled further than {@link CLICK_SLOP_PX} (panning
 *   the map, selecting text);
 * - a click the surface claimed: its handler called `claim()` (selecting
 *   another row swaps the panel's content, it does not close it);
 * - anything outside `region`: popovers, menus and dialogs portalled to the
 *   body (the panel's own tag picker, its delete confirm) and the app chrome;
 * - a click into a modal dialog, or one that opened it: the map vendor's own
 *   dialogs live inside `region` (Google's "Keyboard shortcuts" button opens
 *   a `<dialog>` with `showModal()` in the map's box). The user went into the
 *   dialog, and the card is what they come back to — closing it there also
 *   swapped the side panel back to its list under the dialog's own layout.
 *
 * Listens on the document in the bubble phase, so it hears a click only after
 * React has dispatched it — a claim made in the click's own handler is already
 * recorded — and only DOM ancestry counts: a portal belongs to where it is
 * drawn, not to the component that opened it.
 */
export function useClickAway({
  active,
  region,
  panels,
  onDismiss,
}: {
  active: boolean;
  region: RefObject<HTMLElement | null>;
  /** Stable (memoized): a new list re-arms the listeners. */
  panels: readonly RefObject<HTMLElement | null>[];
  onDismiss: () => void;
}): { claim: () => void } {
  const claimed = useRef(false);
  const dismiss = useEventCallback(onDismiss);

  useEffect(() => {
    if (!active) return;
    let press: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      press = { x: e.clientX, y: e.clientY };
      claimed.current = false;
    };
    const onClick = (e: MouseEvent) => {
      const wasClaimed = claimed.current;
      claimed.current = false;
      // A keyboard click (Enter on a button) has no press and never drags.
      const dragged =
        press !== null &&
        e.detail > 0 &&
        Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX;
      press = null;
      if (wasClaimed || dragged) return;
      const target = e.target;
      if (!(target instanceof Node)) return;
      const screen = region.current;
      if (screen?.contains(target) !== true) return;
      if (inModal(screen, target)) return;
      if (panels.some((p) => p.current?.contains(target) === true)) return;
      dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick);
    };
  }, [active, region, panels, dismiss]);

  // Stable, so a caller may close over it in a memo.
  const claim = useCallback(() => {
    claimed.current = true;
  }, []);
  return { claim };
}

/**
 * Whether a click landed in a dialog or opened a modal one in `screen`: inside
 * a `<dialog>`, or with a `showModal()` dialog in the screen once the target's
 * own handlers ran (this listener bubbles last). `dialog:modal`, never bare
 * `:modal`, which also matches the fullscreen element (the app's Fullscreen
 * switch fullscreens the whole page).
 */
function inModal(screen: HTMLElement, target: Node): boolean {
  const el = target instanceof Element ? target : target.parentElement;
  if (el !== null && el.closest("dialog") !== null) return true;
  return screen.querySelector("dialog:modal") !== null;
}
