import { stripBasePath } from "@plugins/primitives/plugins/pane/web";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import type { ActiveApp } from "./use-active-app";

/**
 * Whether an app entry opens as a tab (it has a `component`), as opposed to a
 * surface-mode app (the desktop), which switches the surface and never owns a
 * tab (its URL is a route PREFIX in front of a tab's URL, stripped before any
 * matching). The one predicate every tab-side reader filters on.
 */
export function isTabApp(
  entry: ActiveApp,
): entry is ActiveApp & { component: NonNullable<ActiveApp["component"]> } {
  return entry.component !== undefined;
}

/**
 * Whether launchers offer the app — the rail, the app galleries and launcher
 * grids. An app declaring `defineApp({ listed: false })` is opened at its URL by
 * something outside equin (the menu-bar panel) and is never picked from inside
 * it; it still owns its URL, its tab and its `app:<id>` scope. The one
 * predicate every launcher filters on.
 */
export function isListedApp(entry: { app: AppRef }): boolean {
  return entry.app.listed !== false;
}

/** Path-prefix match: an app owns `pathname` if it equals or parents it. */
function appMatchesPath(appPath: string, pathname: string): boolean {
  return pathname === appPath || pathname.startsWith(appPath + "/");
}

/**
 * The registered app whose base path best matches `pathname` (longest path
 * wins, so `/studio` beats `/` for `/studio/foo`). No fallback — returns
 * undefined when nothing matches, so callers that need the "is this a real app
 * route" signal (e.g. apps-layout's canonicalization redirect) still get it.
 * Shared by {@link useActiveApp} and {@link resolveAppForPath}.
 */
export function matchAppForPath(
  pathname: string,
  apps: readonly ActiveApp[],
): ActiveApp | undefined {
  const sorted = apps
    .filter(isTabApp)
    .sort((a, b) => b.app.basePath.length - a.app.basePath.length);
  return sorted.find((entry) => appMatchesPath(entry.app.basePath, pathname));
}

export interface ResolvedApp {
  app: ActiveApp;
  /** App-local route path (base path stripped) to feed `parseUrl`. */
  routePath: string;
}

/**
 * Resolve a root-relative `pathname` to the app that should own it AND the
 * app-local route path to load. Every app owns its base-path prefix and all its
 * deep links live under it (e.g. agent-manager's `/agents/c/:id`), so pure
 * longest-prefix matching resolves everything — no catch-all app. Returns
 * undefined when nothing matches (the caller decides what to do, e.g. redirect
 * to the launcher).
 *
 * THE single source of truth for "which tab does this URL belong to", used by
 * the sanctioned cross-app `navigate()` so the focused tab's `appId` can never
 * drift from the URL.
 */
export function resolveAppForPath(
  pathname: string,
  apps: readonly ActiveApp[],
): ResolvedApp | undefined {
  const matched = matchAppForPath(pathname, apps);
  if (!matched) return undefined;
  return {
    app: matched,
    routePath: stripBasePath(pathname, matched.app.basePath),
  };
}
