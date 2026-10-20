import { useSyncExternalStore } from "react";
import type { DesktopTileApp } from "@plugins/apps/plugins/desktop/plugins/shell/web";

/** Live pointer position, in viewport coordinates. */
export interface DragPointer {
  x: number;
  y: number;
}

/**
 * Where the dragged chip would land if released right now, resolved fresh on
 * every pointermove from {@link document.elementFromPoint}:
 *
 * - `strip` — over a window's tab-strip drop-zone (`data-floating-window-id`),
 *   with the computed insertion `index` among that window's member chips. A drop
 *   here reorders (same window) or merges (different window).
 * - `desktop` — over empty desktop (no window strip under the cursor). A drop
 *   here tears the tab off into a fresh window at the drop point.
 */
export type TabDragDrop =
  | { kind: "strip"; windowId: string; index: number }
  | { kind: "desktop" };

/**
 * One in-flight tab-chip drag. There is only ever one drag at a time, so this is
 * a single module-global value (not a per-window map) — the writer is the chip's
 * pointer handler in {@link WindowTabStrip}, the reader is the desktop-level
 * {@link TabDragOverlay} (a Foreground sibling, a different React subtree).
 */
export interface TabDragSession {
  /** The tab being dragged. */
  tabId: string;
  /** The window the drag started in (so a strip drop there is a reorder, not a merge). */
  sourceWindowId: string;
  /** Live pointer position (viewport coords), updated on every pointermove. */
  pointer: DragPointer;
  /** The drag ghost's label (the member's title). */
  label: string;
  /** The drag ghost's app tile (the member's app), if any. */
  app?: DesktopTileApp;
  /** The box a tear-off would open at (the source window's size, capped — mockup 640 × 460). */
  tearSize: { w: number; h: number };
  /** Resolved drop target, or null before the first move resolves one. */
  drop: TabDragDrop | null;
}

// Transient tab-drag channel: the dragging chip's pointer handler writes the live
// session here on every move; the desktop-level <TabDragOverlay> (a Foreground
// sibling of the windows, a different React subtree) reads it. A module-global is
// the right shared channel here for the exact reason `snapPreview` and the
// `windows` map are — writer and reader live in unrelated subtrees under the
// generic surface host, with only ever one tab drag in flight.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: a transient tab-drag-session channel shared between the dragging chip's handler and the desktop-level overlay (separate subtrees), mirroring the module-global snap-preview channel and geometry store in this plugin.
let session: TabDragSession | null = null;
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

/** Begin a tab-chip drag (called once the move threshold is crossed). */
export function startTabDrag(next: TabDragSession) {
  session = next;
  notify();
}

/**
 * Patch the live drag session (pointer and/or drop target). No-op when no drag is
 * in flight. Always notifies — the ghost follows the pointer on every move.
 */
export function updateTabDrag(partial: Partial<TabDragSession>) {
  if (!session) return;
  session = { ...session, ...partial };
  notify();
}

/** End the current drag (clears the channel). No-op when already cleared. */
export function endTabDrag() {
  if (session === null) return;
  session = null;
  notify();
}

/** Reactive read of the live drag session (null while no drag is in flight). */
export function useTabDragSession(): TabDragSession | null {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => session,
    () => session,
  );
}
