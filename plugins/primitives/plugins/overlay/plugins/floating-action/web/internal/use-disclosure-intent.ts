import {
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";

const DEFAULT_CLOSE_DELAY = 150;

export interface DisclosureIntentProps {
  tabIndex: 0;
  "aria-expanded": boolean;
  onPointerDown: () => void;
  onFocus: (e: FocusEvent) => void;
  onBlur: (e: FocusEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export interface DisclosureIntent {
  open: boolean;
  rootProps: DisclosureIntentProps;
}

/**
 * Disclosure-intent state machine for a hover-revealed control.
 *
 * Four independent open sources, OR-ed together, so no single source can
 * suppress another:
 *   - hover    — opens on pointer-enter, closes on pointer-leave after a grace
 *                delay. Re-entry ALWAYS cancels the pending close, so returning
 *                to the trigger reliably reopens — there is no timer "lock" that
 *                swallows a genuine re-entry (the dead-zone bug this replaces).
 *                Hover is the pointer being over the root's DOM box, read from
 *                NATIVE events — never React's synthetic enter/leave, which
 *                follow the React tree: a portaled overlay opened from inside
 *                (the element picker, a popover) counts as "inside" there, and
 *                when it unmounts under the cursor React synthesizes no leave
 *                at all, so hover stuck on and the open panel kept covering
 *                what was behind it. While hovered, every document pointer
 *                move re-checks containment, which catches that removal.
 *   - focus    — opens while KEYBOARD focus (`:focus-visible`) is anywhere
 *                inside the subtree, so the control is reachable by Tab, not
 *                mouse-only. A mouse click leaves its button focused; counting
 *                that would pin the panel open long after the pointer left.
 *                `:focus-visible` alone is not enough: a popover closed after
 *                any key (typing in it, Escape, a submit shortcut) hands focus
 *                back to its trigger, and Chrome marks that restored focus
 *                visible too. So the pointer outranks focus: a pointer moving
 *                outside the control ends a focus open exactly as it ends a
 *                hover open. Keyboard focus reopens it on the next focus
 *                event (a Tab).
 *   - latch    — a pointer-press while fully closed (the touch path, where
 *                there is no hover) pins it open until Esc or an outside press.
 *                Presses while already open are left to bubble to the content,
 *                so tapping an item inside never toggles the panel shut.
 *
 *   - held     — a popup opened from inside the panel (a popover, menu, select)
 *                is still open. That popup is drawn outside the panel's box,
 *                so reaching for it reads as a pointer-leave and a blur; `held`
 *                keeps the panel open under it. While held, Escape and presses
 *                belong to the popup: the panel ignores them, so closing the
 *                popup does not take the panel with it.
 *
 * And one override:
 *   - suppressed — the control is being moved (dragged by its host): it stays
 *                closed whatever the pointer does, and the hover and latch it
 *                saw meanwhile are dropped. So lifting it leaves the control
 *                closed under a pointer still on it; it opens again on the next
 *                enter, focus or press, never by itself.
 *
 * Flicker (rapid open/close as the morphing panel's geometry shifts under the
 * cursor) is handled structurally by the caller pinning a stable hover hitbox,
 * plus the grace delay here — never by ignoring input.
 */
export function useDisclosureIntent(
  rootRef: RefObject<HTMLElement | null>,
  closeDelay = DEFAULT_CLOSE_DELAY,
  held = false,
  suppressed = false,
): DisclosureIntent {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [latched, setLatched] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // For the DOM listeners, which outlive a render.
  const suppressedRef = useLatestRef(suppressed);

  // While suppressed, whatever opened it is forgotten (adjusting state from a
  // prop during render, React's documented pattern): the press that started
  // the drag latched it, and the pointer is still over it.
  if (suppressed && (hovered || focused || latched)) {
    setHovered(false);
    setFocused(false);
    setLatched(false);
  }

  const open = !suppressed && (hovered || focused || latched || held);

  // `closeTimer.current` is defined exactly while a hover close is pending.
  const cancelClose = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  // Idempotent: re-arming on every pointer move outside would postpone the
  // close forever while the cursor keeps moving.
  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== undefined) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined;
      setHovered(false);
      // The pointer is elsewhere: focus left behind inside (a popover's
      // restored focus) no longer speaks for the user's intent.
      setFocused(false);
    }, closeDelay);
  }, [closeDelay]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const enter = () => {
      if (suppressedRef.current) return;
      cancelClose();
      setHovered(true);
    };
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointerleave", scheduleClose);
    return () => {
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", scheduleClose);
    };
  }, [rootRef, cancelClose, scheduleClose, suppressedRef]);

  // An element removed from under the cursor (a portaled overlay closing)
  // fires no leave on the root, and focus restored to the trigger by a closing
  // popover arrives with the pointer already outside — so while open by hover
  // or focus, re-check containment on every move: the first move that lands
  // outside the root starts the close (which ends both).
  useEffect(() => {
    if (!hovered && !focused) return;
    const onDocPointerMove = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) scheduleClose();
    };
    document.addEventListener("pointermove", onDocPointerMove);
    return () => document.removeEventListener("pointermove", onDocPointerMove);
  }, [hovered, focused, rootRef, scheduleClose]);

  const onPointerDown = useCallback(() => {
    // Touch has no hover: the first press on a closed control opens it. While
    // already open, leave the press alone so it reaches the content.
    if (suppressedRef.current) return;
    setLatched((latchedNow) => (open ? latchedNow : true));
  }, [open, suppressedRef]);

  const onFocus = useCallback(
    (e: FocusEvent) => {
      // Only keyboard focus opens (see `focus` above); a pointer-driven focus
      // moving inside clears it, so the panel follows the pointer again.
      const keyboard =
        !suppressedRef.current &&
        (e.target as Element).matches(":focus-visible");
      if (keyboard) cancelClose();
      setFocused(keyboard);
    },
    [cancelClose, suppressedRef],
  );

  const onBlur = useCallback((e: FocusEvent) => {
    // Only collapse once focus has left the whole subtree, not when it moves
    // between the trigger and an item inside the panel.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setFocused(false);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // A popup opened from inside handles its own Escape; React bubbles the
      // key to us through its portal, and it must close only the popup.
      if (e.key === "Escape" && open && !held) {
        e.stopPropagation();
        cancelClose();
        setHovered(false);
        setLatched(false);
      }
    },
    [open, held, cancelClose],
  );

  // An outside press dismisses a latched (touch / click) open. Hover and focus
  // opens dismiss themselves via pointer-leave / blur.
  // A press inside a popup opened from the panel is not outside it: the popup is
  // drawn elsewhere in the DOM, but it is the panel's own content.
  useEffect(() => {
    if (!latched || held) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setLatched(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [latched, held, rootRef]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return {
    open,
    rootProps: {
      tabIndex: 0,
      "aria-expanded": open,
      onPointerDown,
      onFocus,
      onBlur,
      onKeyDown,
    },
  };
}
