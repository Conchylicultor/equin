/**
 * Whether the page is on screen — the gate for a toast nobody asked for.
 *
 * A toast is either an answer to something the user did (Copied, a failed
 * save — raised whatever the page's state, since the user is waiting for it)
 * or an ANNOUNCEMENT of something that happened on its own (a notification
 * arriving, the server reconnecting). An announcement is for a user looking at
 * the page: raise it only when this answers true, and leave the record of it
 * to its persistent surface (the bell).
 *
 * Why it matters beyond noise: sonner pauses every toast's dismiss timer
 * while the document is hidden (`useIsDocumentHidden`), and keeps every toast
 * in its list mounted (only the front three are drawn). So an announcement
 * raised in a hidden tab never leaves until the tab is shown — a background
 * tab left open through a busy evening collected one toast (~40 DOM nodes and
 * a custom toast's portal root) per notification, ~12k nodes in 2 h
 * (report-1794679800-lyevgy, 2026-11-14).
 */
export function isPageOnScreen(): boolean {
  return document.visibilityState === "visible";
}
