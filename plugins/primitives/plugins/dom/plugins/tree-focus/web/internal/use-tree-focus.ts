import { useCallback, useRef, type FocusEvent } from "react";

export interface TreeFocus {
  /** Spread on the component's root element. */
  onFocusCapture: (e: FocusEvent) => void;
  /** Whether DOM focus is on an element of the component's React tree. */
  holdsFocus: () => boolean;
}

/**
 * Whether focus is inside a component's REACT tree, portals included.
 *
 * `root.contains(document.activeElement)` answers for the DOM, where a popover
 * the component opened is not inside it: popovers, menus and dialogs portal to
 * `document.body`. A focus-pull guard asking the DOM therefore takes focus back
 * from the component's own menu the moment the menu takes it (a table grip's
 * menu, focused on open, had its focus pulled back onto the table — with a
 * scroll).
 *
 * React bubbles a synthetic focus event up the COMPONENT tree, through portals,
 * so the root's capture handler sees exactly the focuses that happen inside the
 * component as the user would read it. It records the last one; focus is held
 * while that element is still the active one. Focus leaving for anywhere else
 * makes `activeElement` some other element (or `<body>`), so no blur tracking
 * is needed.
 */
export function useTreeFocus(): TreeFocus {
  const last = useRef<EventTarget | null>(null);
  const onFocusCapture = useCallback((e: FocusEvent) => {
    last.current = e.target;
  }, []);
  const holdsFocus = useCallback(() => {
    const active = document.activeElement;
    return (
      active !== null && active !== document.body && active === last.current
    );
  }, []);
  return { onFocusCapture, holdsFocus };
}
