import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { placePhoto, placeThumbnail } from "../core";
import { handlePlacePhoto } from "./internal/handle-photo";
import { handlePlaceThumbnail } from "./internal/thumbnail";
import { placeDetailsServed } from "./internal/resources";

export default {
  description:
    "Desktop half (all of it: Google's Places API reads the computer's Places key, so places.details and the photo and thumbnail routes are needsMachine). Serves Google's rich details of a saved place (photos, opening hours, rating, price level, phone, website, summary) as the places.details value — at the richest tier this month's Google budget allows (with summary → without → photos only, free), one call per place per tier per day, kept in memory, never stored — and proxies its photos (GET /api/places/photo, refused once the Place Photo budget is spent) so the Places key stays on the server; and serves each Google place's gallery thumbnail (its first photo, fetched once and cached on disk; GET /api/places/thumbnail).",
  httpRoutes: {
    [placePhoto.route]: machineHandler(placePhoto, handlePlacePhoto),
    [placeThumbnail.route]: machineHandler(
      placeThumbnail,
      handlePlaceThumbnail,
    ),
  },
  contributions: [...placeDetailsServed.declare],
} satisfies MachinePluginDefinition;
