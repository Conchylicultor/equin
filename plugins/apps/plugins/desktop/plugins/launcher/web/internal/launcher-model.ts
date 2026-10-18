/**
 * The launcher's pure model: what a query lists, in which order, and where the
 * arrow keys move the selection. No React, no registries — the overlay feeds it
 * the launchable apps and the commands and draws what it returns.
 */

/** The grid's column count; the arrow keys step by it vertically. */
export const LAUNCHER_COLUMNS = 6;

/** One thing the launcher can run: an app (open / switch to) or a command. */
export type LauncherItem<A, C> =
  { kind: "app"; app: A } | { kind: "command"; command: C };

/**
 * What the launcher lists for a query. An empty query is the grid of every app
 * (no commands); a query is the list of the apps whose name contains it, then
 * the commands whose label does — `items` is that listing flattened in the
 * order it is drawn, which is the order the selection index walks.
 */
export interface LauncherListing<A, C> {
  layout: "grid" | "list";
  apps: A[];
  commands: C[];
  items: LauncherItem<A, C>[];
}

/** Case-insensitive substring match; the query is trimmed by the caller. */
function includesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query);
}

export function listLauncher<
  A extends { name: string },
  C extends { label: string },
>(
  rawQuery: string,
  apps: readonly A[],
  commands: readonly C[],
): LauncherListing<A, C> {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") {
    return {
      layout: "grid",
      apps: [...apps],
      commands: [],
      items: apps.map((app) => ({ kind: "app", app })),
    };
  }
  const matchedApps = apps.filter((a) => includesQuery(a.name, query));
  const matchedCommands = commands.filter((c) => includesQuery(c.label, query));
  return {
    layout: "list",
    apps: matchedApps,
    commands: matchedCommands,
    items: [
      ...matchedApps.map((app): LauncherItem<A, C> => ({ kind: "app", app })),
      ...matchedCommands.map((command): LauncherItem<A, C> => ({
        kind: "command",
        command,
      })),
    ],
  };
}

/** Keep a selection index inside a listing of `count` items (0 when empty). */
export function clampSelection(selection: number, count: number): number {
  return Math.max(0, Math.min(count - 1, selection));
}

export type SelectionKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/**
 * The selection after an arrow key. The grid moves by a column vertically and by
 * one horizontally; the list moves by one vertically and ignores left / right.
 * The ends clamp (no wrap), like the mockup.
 */
export function moveSelection(
  selection: number,
  key: SelectionKey,
  layout: "grid" | "list",
  count: number,
): number {
  const grid = layout === "grid";
  const step = {
    ArrowDown: grid ? LAUNCHER_COLUMNS : 1,
    ArrowUp: grid ? -LAUNCHER_COLUMNS : -1,
    ArrowRight: grid ? 1 : 0,
    ArrowLeft: grid ? -1 : 0,
  }[key];
  return clampSelection(selection + step, count);
}

/** The slice of a window the launcher groups by app. */
export interface WindowOfApp {
  id: string;
  desktopId: string;
  activeTabId: string;
  geo: { z: number };
}

/**
 * The windows on `desktopId` per app, each list front-most first (`geo.z`
 * descending). A window is "of" the app of its ACTIVE tab (`appOfTab`), so a
 * window mixing apps is filed under the one it shows; a tab nobody knows
 * (closing) files its window under nothing.
 */
export function windowsByApp<W extends WindowOfApp>(
  windows: Iterable<W>,
  desktopId: string,
  appOfTab: ReadonlyMap<string, string>,
): Map<string, W[]> {
  const byApp = new Map<string, W[]>();
  for (const w of windows) {
    if (w.desktopId !== desktopId) continue;
    const appId = appOfTab.get(w.activeTabId);
    if (appId === undefined) continue;
    const list = byApp.get(appId);
    if (list) list.push(w);
    else byApp.set(appId, [w]);
  }
  for (const list of byApp.values()) list.sort((a, b) => b.geo.z - a.geo.z);
  return byApp;
}
