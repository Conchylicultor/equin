import {
  setAddressRoot,
  setRoutePrefixes,
} from "@plugins/primitives/plugins/pane/plugins/route-prefix/web";
import { useComposition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "../slots";
import { homeApp } from "./home-app";
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
 * pane primitive's URL reader strips it — and, for a composition serving its
 * home app at `/` (`homeAtRoot`), the home app's base path as the address
 * root, so every read puts it back and every write drops it. Called during
 * render, BEFORE the first routing read of the apps root: the `Apps.App`
 * entries are eager and the install is idempotent, so the earliest reader
 * already sees plain app routes.
 */
export function useInstallRoutePrefixes(): void {
  const apps = Apps.App.useContributions();
  const { home, homeAtRoot } = useComposition();
  setRoutePrefixes(
    apps.flatMap((a) => (a.surfaceMode === undefined ? [] : [a.app.basePath])),
  );
  setAddressRoot(homeAtRoot === true ? addressRootOf(apps, home) : null);
}

/**
 * The base path the address root is: the home app's. A composition whose home
 * did not register cannot read its own address bar — thrown, never guessed.
 */
function addressRootOf(
  apps: readonly ActiveApp[],
  homeId: string | null,
): string {
  const home = homeApp(apps, homeId);
  if (home.kind !== "app") {
    throw new Error(
      `[apps-core] the composition serves its home app at / (homeAtRoot), but its home app ${homeId === null ? "is not declared" : `"${homeId}" is not registered`} — no address can be read`,
    );
  }
  return home.app.app.basePath;
}
