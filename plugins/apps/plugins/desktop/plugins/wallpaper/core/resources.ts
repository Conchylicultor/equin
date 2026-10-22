import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { WallpaperResultSchema } from "./config";

/** The longest query a provider is asked (a longer one is refused `invalid-query`). */
export const WALLPAPER_QUERY_MAX = 200;

/**
 * One search of one server-side wallpaper provider (Openverse, …), keyed by
 * `(provider, q)`: the thumbnails (with full url + attribution) the picker
 * grid shows. Generic — `provider` routes to the server registry, and this
 * plugin names no provider.
 *
 * Bounded: the answer is ONE page of the provider's results, never a paged
 * list — each provider caps its own page (Openverse asks for 20), which is
 * plenty to pick a wallpaper from.
 *
 * On-demand: an answer is a third-party call nothing pushes a change to;
 * a new question is a new tuple.
 *
 * Refusals:
 * - `unknown-provider` — no provider registered under `provider`;
 * - `invalid-query` — an empty query, or one longer than
 *   {@link WALLPAPER_QUERY_MAX}.
 *
 * A provider throttling requests for now (Openverse's anonymous tier) is a
 * failure, not a refusal: it passes, so the read's error offers Retry.
 */
export const wallpaperSearch = liveValue("wallpaper.search", {
  schema: z.array(WallpaperResultSchema),
  params: ["provider", "q"],
  refusals: ["unknown-provider", "invalid-query"],
  load: "on-demand",
});
