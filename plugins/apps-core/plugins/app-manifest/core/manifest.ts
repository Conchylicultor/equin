import type { AppDeclaration } from "@plugins/apps-core/core";
import { appIcon, appTileFill } from "@plugins/apps-core/plugins/app-icon/core";
import { endpointPath } from "@plugins/infra/plugins/endpoints/core";
import {
  appIconFile,
  getAppIconPng,
  getAppManifest,
  type AppIconSize,
  type WebAppManifest,
} from "./endpoints";

/**
 * The app `appId` names among `apps` when it can be installed — any app, since
 * each owns a URL: a tab app its routes, a surface-mode app (the desktop) its
 * base path as a route prefix (`/desktop`, `/desktop/agents/c/x`). Not an
 * unlisted app (`defineApp({ listed: false })`), which only something outside
 * equin opens.
 */
export function installableApp(
  apps: readonly AppDeclaration[],
  appId: string,
): AppDeclaration["app"] | undefined {
  const found = apps.find((d) => d.app.id === appId);
  return found !== undefined && found.app.listed !== false
    ? found.app
    : undefined;
}

/** Where the app's manifest is served. */
export function appManifestPath(appId: string): string {
  return endpointPath(getAppManifest, { appId });
}

/** Where one size of the app's icon PNG is served. */
export function appIconPath(appId: string, size: AppIconSize): string {
  return endpointPath(getAppIconPng, { appId, file: appIconFile(size) });
}

/**
 * One installable app's web-app manifest. Its `id`, `start_url` and `scope`
 * are the app's base path, which is distinct per app, so every app installs as
 * its own OS app and no two scopes overlap. (`scope` is the base path itself,
 * not `<basePath>/`: `start_url` must lie inside it, and the app opens at its
 * bare base path.) The window's colour is the app's tile colour.
 */
export function appManifestFor(app: AppDeclaration["app"]): WebAppManifest {
  const fill = appTileFill(appIcon(app.icon, { color: app.iconColor }), app.id);
  return {
    id: app.basePath,
    name: app.name,
    short_name: app.name,
    start_url: app.basePath,
    scope: app.basePath,
    display: "standalone",
    theme_color: fill,
    background_color: fill,
    icons: ([192, 512] as const).map((size) => ({
      src: appIconPath(app.id, size),
      sizes: `${size}x${size}`,
      type: "image/png" as const,
      purpose: "any" as const,
    })),
  };
}
