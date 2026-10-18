/**
 * The shelf's pure model: which entries it shows, in which order, and what a
 * click on one does. No React, no store: the hook (`use-shelf-model.ts`) feeds
 * it the live windows and config, and the tests feed it plain data.
 */

/** A window as the shelf sees it: who it is filed under, and its state. */
export interface ShelfWindow {
  id: string;
  /** The app of the window's ACTIVE tab: a window is "of" that app. */
  appId: string;
  minimized: boolean;
  /** Stacking rank (higher is in front). */
  z: number;
}

/** One app entry on the shelf (`instances: grouped`: one per app). */
export interface ShelfEntry {
  appId: string;
  /** `pinned` entries come first; a separator splits them from `running`. */
  section: "pinned" | "running";
  /** The app's windows on the active desktop, in first-open order. */
  windows: ShelfWindow[];
}

/**
 * The shelf's entries for the active desktop: the pinned apps first (in the
 * order the config lists them), then the apps that run without being pinned, in
 * the order their first window opened — such an entry appears with its first
 * window and leaves with its last. A pinned id that is not an installed app is
 * skipped (an app removed since it was pinned), and so is a window whose app is
 * not installed.
 *
 * `windows` is the active desktop's windows in first-open order.
 */
export function shelfEntries(
  pinned: readonly string[],
  windows: readonly ShelfWindow[],
  installed: ReadonlySet<string>,
): ShelfEntry[] {
  const byApp = new Map<string, ShelfWindow[]>();
  for (const w of windows) {
    if (!installed.has(w.appId)) continue;
    const list = byApp.get(w.appId);
    if (list) list.push(w);
    else byApp.set(w.appId, [w]);
  }
  const pinnedSet = new Set(pinned);
  const out: ShelfEntry[] = [];
  const seen = new Set<string>();
  for (const appId of pinned) {
    if (!installed.has(appId) || seen.has(appId)) continue;
    seen.add(appId);
    out.push({ appId, section: "pinned", windows: byApp.get(appId) ?? [] });
  }
  // Map iteration is insertion order: the order each app's first window came.
  for (const [appId, list] of byApp) {
    if (pinnedSet.has(appId)) continue;
    out.push({ appId, section: "running", windows: list });
  }
  return out;
}

/** What one window click does: bring it forward, restore it, or hide it. */
export type WindowAction =
  | { kind: "focus"; windowId: string }
  | { kind: "restore"; windowId: string }
  | { kind: "minimize"; windowId: string };

/** What a click on an entry does: a window action, or open a new window. */
export type EntryAction = WindowAction | { kind: "open" };

/**
 * A click on one window (a thumbnail, a single-window entry): restore it when
 * minimised, minimise it when it is already the focused window, otherwise
 * bring it forward.
 */
export function windowClick(
  w: ShelfWindow,
  focusedWindowId: string | null,
): WindowAction {
  if (w.minimized) return { kind: "restore", windowId: w.id };
  if (w.id === focusedWindowId) return { kind: "minimize", windowId: w.id };
  return { kind: "focus", windowId: w.id };
}

/**
 * A click on an app entry. No window → open one. One → {@link windowClick}.
 * Several → while one of them is focused, the click cycles to the next in
 * first-open order; otherwise it brings the app forward: its front-most
 * visible window, or (all minimised) its front-most one, restored.
 */
export function entryClick(
  windows: readonly ShelfWindow[],
  focusedWindowId: string | null,
): EntryAction {
  if (windows.length === 0) return { kind: "open" };
  if (windows.length === 1) return windowClick(windows[0]!, focusedWindowId);
  const focusedAt = windows.findIndex((w) => w.id === focusedWindowId);
  const target =
    focusedAt >= 0
      ? windows[(focusedAt + 1) % windows.length]!
      : frontMost(windows);
  return target.minimized
    ? { kind: "restore", windowId: target.id }
    : { kind: "focus", windowId: target.id };
}

/** The front-most visible window, else the front-most minimised one. */
function frontMost(windows: readonly ShelfWindow[]): ShelfWindow {
  const byZ = [...windows].sort((a, b) => b.z - a.z);
  return byZ.find((w) => !w.minimized) ?? byZ[0]!;
}
