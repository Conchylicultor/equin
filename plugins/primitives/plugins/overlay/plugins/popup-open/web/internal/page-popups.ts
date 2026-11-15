import { useEffect } from "react";

/**
 * How many popups are open on the whole page, whatever region or plugin scope
 * they were opened in — for page-wide chrome that must not compete with one
 * (the hints engine holds a tip back while the user is in a menu). Unlike
 * {@link PopupOpenScope} there is no nearest-scope rule: every open popup
 * counts once.
 */
let openCount = 0;
const listeners = new Set<() => void>();

function setOpenCount(next: number): void {
  openCount = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Publishes a popup's open state page-wide. Called by ui-kit's open-state
 * mirror (`DropdownMenu`, `Popover`, `Select` — the popups a user opens), so
 * only a real popup counts: a region that holds itself open through
 * `useReportPopupOpen` (a hint's anchor, an editor panel) is not one.
 *
 * Counted, released by the effect's cleanup — closing and unmounting while open
 * take the same path, so an unmount never latches the page open.
 */
export function usePublishOpenPopup(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    setOpenCount(openCount + 1);
    return () => setOpenCount(openCount - 1);
  }, [open]);
}

/** Whether any popup is open on the page right now. */
export function anyPopupOpen(): boolean {
  return openCount > 0;
}

/** Calls `listener` whenever a popup opens or closes anywhere on the page. */
export function subscribeOpenPopups(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
