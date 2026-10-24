import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { getAppManifest } from "../core";
import { appManifestDocumentHead } from "./internal/document-head";
import { handleAppManifest } from "./internal/manifest-route";

export default {
  description:
    "Makes every listed app installable as its own OS app: serves GET /api/apps/:appId/manifest.webmanifest (id / start_url / scope = the app's base path, its tile colour, its icon PNGs) from the generated app declarations, and links it from each app's pages through a DocumentHead.Fragment (manifest, theme-color, apple-touch-icon). A surface-mode app (the desktop) installs at its base path, the route prefix of every page it shows.",
  httpRoutes: {
    [getAppManifest.route]: handleAppManifest,
  },
  contributions: [appManifestDocumentHead],
  portable: true,
} satisfies ServerPluginDefinition;
