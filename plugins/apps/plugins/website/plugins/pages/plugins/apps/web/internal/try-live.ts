import { demoPagePath } from "@plugins/apps/plugins/website/plugins/live-demo/core";
import { APP_DEMO_PLACES } from "../../core";
import type { CatalogApp } from "./catalog";

/**
 * Where an app's "Try it live" goes: the demo page on the app's home — never
 * the staged frame its picture shows. `undefined` for an app the demo does not
 * carry.
 */
export function tryLivePath(app: CatalogApp): string | undefined {
  const place = APP_DEMO_PLACES[app.id];
  if (place === undefined) return undefined;
  return demoPagePath(place.home);
}
