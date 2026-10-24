import { declaredApps } from "@plugins/apps-core/server";
import { appIcon, appTileFill } from "@plugins/apps-core/plugins/app-icon/core";
import {
  DocumentHead,
  type HeadFragments,
} from "@plugins/shell/plugins/document-head/server";
import { appIconPath, appManifestPath } from "../../core";

/** Attribute-safe text (the values are ours, but an app name is free text). */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/**
 * Per installable app's base path: the head tags that make the page
 * installable as that app — its manifest, its window colour and the icon iOS /
 * macOS Safari read. Every other path gets nothing (`""` is absent), so a page
 * outside every app installs as nothing.
 */
async function render(): Promise<HeadFragments> {
  const head: HeadFragments = {};
  for (const { app, launch } of declaredApps) {
    if (launch !== "tab") continue;
    // An unlisted app installs as nothing — and says so at its own path, so a
    // base path nested in another app's (`/home/menu-bar`) does not inherit
    // that app's manifest by longest match.
    if (app.listed === false) {
      head[app.basePath] = "";
      continue;
    }
    const fill = appTileFill(
      appIcon(app.icon, { color: app.iconColor }),
      app.id,
    );
    head[app.basePath] =
      `<link rel="manifest" href="${attr(appManifestPath(app.id))}">` +
      `<meta name="theme-color" content="${attr(fill)}">` +
      `<meta name="application-name" content="${attr(app.name)}">` +
      `<link rel="apple-touch-icon" href="${attr(appIconPath(app.id, 192))}">`;
  }
  return head;
}

/** The app set is generated at build time, so nothing changes it while running. */
function subscribe(): () => void {
  return () => undefined;
}

/** Makes every app's own pages installable as that app (a web-app manifest per base path). */
export const appManifestDocumentHead = DocumentHead.Fragment({
  id: "app-manifest",
  render,
  subscribe,
});
