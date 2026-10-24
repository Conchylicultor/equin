import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/** One icon of a web-app manifest. */
export const WebAppManifestIconSchema = z.object({
  src: z.string(),
  sizes: z.string(),
  type: z.literal("image/png"),
  purpose: z.literal("any"),
});

/**
 * An installable app's web-app manifest (W3C Web App Manifest): what a browser
 * reads to install the app as its own window — its identity (`id`), what it
 * covers (`scope`), where it opens and how it looks in the OS.
 */
export const WebAppManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  short_name: z.string(),
  start_url: z.string(),
  scope: z.string(),
  display: z.literal("standalone"),
  theme_color: z.string(),
  background_color: z.string(),
  icons: z.array(WebAppManifestIconSchema),
});
export type WebAppManifest = z.infer<typeof WebAppManifestSchema>;

/**
 * `GET /api/apps/:appId/manifest.webmanifest` — one app's manifest, from the
 * apps the browser registers (`declaredApps`). An unlisted app or an unknown
 * id is a 404. Portable: pure data.
 */
export const getAppManifest = defineEndpoint({
  route: "GET /api/apps/:appId/manifest.webmanifest",
  response: WebAppManifestSchema,
});

/**
 * `GET /api/apps/:appId/icon/:file` — the app's icon as a PNG, `:file` being
 * `<size>.png` for a size in {@link APP_ICON_SIZES}: the app's glyph on its
 * tile colour, rasterized on the computer (the glyph is read from the installed
 * icon sets), so desktop-only.
 */
export const getAppIconPng = defineEndpoint({
  route: "GET /api/apps/:appId/icon/:file",
  response: blob("image/png"),
  needsMachine: { feature: "App icons" },
});

/**
 * The closed set of PNG sizes the icon route renders: 192 and 512 (what a
 * web-app manifest lists), 1024 (an `.icns` set's largest).
 */
export const APP_ICON_SIZES = [192, 512, 1024] as const;
export type AppIconSize = (typeof APP_ICON_SIZES)[number];

/** The `:file` segment naming one size's PNG. */
export function appIconFile(size: AppIconSize): string {
  return `${size}.png`;
}

/** The size a `:file` segment names, or null when it names none of the set. */
export function parseAppIconFile(file: string): AppIconSize | null {
  return APP_ICON_SIZES.find((s) => appIconFile(s) === file) ?? null;
}
