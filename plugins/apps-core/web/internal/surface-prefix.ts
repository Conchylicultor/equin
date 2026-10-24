import { setRoutePrefixes } from "@plugins/primitives/plugins/pane/plugins/route-prefix/web";
import { Apps } from "../slots";
import type { ActiveApp } from "./use-active-app";

/**
 * A surface-mode app's URL is its base path written in FRONT of the focused
 * tab's own URL — the desktop at `/desktop/agents/c/42`, bare `/desktop` with
 * no window — rather than a route of its own (`pane/plugins/route-prefix`).
 * These derive the mode ↔ prefix pairing from the `Apps.App` entries, so the
 * prefix is the app's `basePath`, authored once in its `defineApp`.
 */

/** The route prefix the surface `mode` writes, if a surface-mode app owns it. */
export function routePrefixForMode(
  mode: string,
  apps: readonly ActiveApp[],
): string | undefined {
  return apps.find((a) => a.surfaceMode === mode)?.app.basePath;
}

/** The surface mode a route prefix names, if any. */
export function surfaceModeForPrefix(
  prefix: string | undefined,
  apps: readonly ActiveApp[],
): string | undefined {
  if (prefix === undefined) return undefined;
  return apps.find(
    (a) => a.surfaceMode !== undefined && a.app.basePath === prefix,
  )?.surfaceMode;
}

/**
 * Install every surface-mode app's base path as a known route prefix, so the
 * pane primitive's URL reader strips it. Called during render, BEFORE the first
 * routing read of the apps root: the `Apps.App` entries are eager and the
 * install is idempotent, so the earliest reader already sees plain app routes.
 */
export function useInstallRoutePrefixes(): void {
  const apps = Apps.App.useContributions();
  setRoutePrefixes(
    apps.flatMap((a) => (a.surfaceMode === undefined ? [] : [a.app.basePath])),
  );
}
