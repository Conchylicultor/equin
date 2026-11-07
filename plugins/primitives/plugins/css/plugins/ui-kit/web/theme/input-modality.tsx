import { useEffect } from "react";

/**
 * Whether the user is driving the page with the pointer or navigating it with
 * the keyboard — stamped on `<html>` as `data-input-modality="pointer"` (absent
 * = keyboard), read by the `focus-ring` utilities in `app.css`.
 *
 * `:focus-visible` alone is not enough. Chrome marks focus visible whenever the
 * last input was ANY key, so a popover opened with a click and closed with
 * Escape (or a submit shortcut) hands focus back to its trigger with a ring
 * the user never navigated to. Here only a NAVIGATION key — one that moves
 * focus or a highlight — flips the page back to keyboard; Escape, Enter and
 * typing do not. A pointer press flips it to pointer.
 */
export function InputModalityTracker() {
  useEffect(() => {
    const root = document.documentElement;
    const onPointer = () => {
      root.dataset.inputModality = "pointer";
    };
    const onKey = (e: KeyboardEvent) => {
      if (NAVIGATION_KEYS.has(e.key)) delete root.dataset.inputModality;
    };
    document.addEventListener("pointerdown", onPointer, true);
    // eslint-disable-next-line shortcuts/no-window-key-listener -- observes every keystroke on the page to tell keyboard navigation from pointer use; it handles none of them.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      delete root.dataset.inputModality;
    };
  }, []);
  return null;
}

const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
