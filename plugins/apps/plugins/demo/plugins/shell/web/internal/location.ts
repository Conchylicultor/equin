import { useHomeApp, type HomeApp } from "@plugins/apps-core/web";
import { useDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";

/**
 * The demo's location as the route's `url` param: the embed's app-rooted URL
 * (`/agents/c/x`) without its leading slash — the wildcard's spelling.
 */
export function locationParam(url: string): string {
  return url.replace(/^\/+/, "");
}

/** The route's `url` param back as the embed's app-rooted URL. */
export function locationUrl(param: string): string {
  return `/${param}`;
}

/**
 * Where the demo starts, as a `url` param: its composition's home app (the
 * app gallery). `undefined` while that app's shell may still be loading (the
 * deferred tier); a composition with no home app to start on throws.
 */
export function useStartLocation(): string | undefined {
  return startLocation(useHomeApp(), useDeferredLoadComplete());
}

function startLocation(home: HomeApp, loaded: boolean): string | undefined {
  if (home.kind === "app") {
    const param = locationParam(home.app.app.basePath);
    // A root-based home has no location the wildcard can spell (`at/` + "").
    if (param === "")
      throw new Error(
        `The demo's home app "${home.app.id}" is based at "/": the demo's URL cannot address it.`,
      );
    return param;
  }
  if (home.kind === "unregistered" && !loaded) return undefined;
  throw new Error(
    home.kind === "unregistered"
      ? `The demo's home app "${home.id}" is not in its composition.`
      : "The demo's composition declares no home app to start on.",
  );
}
