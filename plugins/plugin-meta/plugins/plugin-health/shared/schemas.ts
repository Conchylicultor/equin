import { liveCollection } from "@plugins/network/plugins/live/core";
import { pluginHealthReviewFields } from "../core";

const { pluginId, axis, ...carried } = pluginHealthReviewFields;

// The recorded reviews, as a live collection over `plugin_health_reviews`: a
// bounded window (by axis, 50 / max 200) plus its `:rows` point sibling. The
// plugin pane scopes it to one plugin with `where: { pluginId }` — the server
// filters, so a tab never ships every plugin's reviews to count one plugin's.
// The table holds at most one row per (pluginId, axis) — the unique-index
// conflict target a re-review UPDATEs in place — so one plugin's window holds
// one row per axis it was reviewed along.
export const pluginHealthReviews = liveCollection("plugin-health-reviews", {
  fields: { pluginId, axis },
  carry: { fields: carried },
  id: "id",
  sortable: ["axis"],
  default: { orderBy: [["axis", "asc"]], limit: 50 },
  maxLimit: 200,
});
