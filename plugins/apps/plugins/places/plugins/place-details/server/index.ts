import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { placePhoto, placeThumbnail } from "../core";
import { handlePlacePhoto } from "./internal/handle-photo";
import { handlePlaceThumbnail } from "./internal/thumbnail";
import { placeDetailsServed } from "./internal/resources";

export default {
  description:
    "Serves Google's rich details of a saved place (photos, opening hours, rating, price level, phone, website, summary) as the places.details value — one Enterprise Place Details call per place per day, kept in memory, never stored — and proxies its photos (GET /api/places/photo) so the Places key stays on the server; and serves each Google place's gallery thumbnail (its first photo, fetched once and cached on disk; GET /api/places/thumbnail).",
  httpRoutes: {
    [placePhoto.route]: handlePlacePhoto,
    [placeThumbnail.route]: handlePlaceThumbnail,
  },
  contributions: [...placeDetailsServed.declare],
} satisfies ServerPluginDefinition;
