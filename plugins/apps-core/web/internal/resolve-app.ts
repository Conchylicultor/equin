import { stripBasePath } from "@plugins/primitives/plugins/pane/web";
import type { ActiveApp } from "./use-active-app";

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
  const sorted = [...apps].sort(
    (a, b) => b.app.basePath.length - a.app.basePath.length,
  );
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
