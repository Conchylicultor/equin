import type { AppDeclaration } from "@plugins/apps-core/core";

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
