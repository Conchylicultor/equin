import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * One app the native helper keeps installed as an OS app: what its launcher
 * shim is written from. The helper composes the URL itself (its instance's
 * origin + `basePath`), so the catalog says nothing about where it is served.
 */
export const CatalogAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The app's base path (`/mail`) on the instance. */
  basePath: z.string(),
  /**
   * The app's fingerprint: a hash of its id, name, base path and icon
   * picture. A shim recording another one is stale and rewritten.
   */
  hash: z.string(),
  /** The icon PNG at each pixel size, as instance-relative paths. */
  icons: wholeList(z.object({ size: z.number().int(), path: z.string() }), {
    reason: "one entry per icon size the icon route renders — a closed set",
  }),
});
export type CatalogApp = z.infer<typeof CatalogAppSchema>;

export const AppCatalogSchema = z.object({
  apps: wholeList(CatalogAppSchema, {
    reason: "one entry per installable app — bounded by the apps there are",
  }),
});
export type AppCatalog = z.infer<typeof AppCatalogSchema>;

/**
 * `GET /api/menu-bar/apps` — every installable app, as the native helper
 * (`menu-bar/rust`, `apps.rs`) installs it: the helper holds the device
 * power (writing `~/Applications` / `~/.local/share/applications`, the Dock,
 * the dash); the instance only says which apps exist and what they look like.
 * Owner-only like every route: the helper is a local tool (no browser
 * headers), which the gateway stamps as the owner. Read by the helper only,
 * never by a browser.
 */
export const getAppCatalog = defineEndpoint({
  route: "GET /api/menu-bar/apps",
  response: AppCatalogSchema,
  needsMachine: { feature: "Installing apps" },
});
