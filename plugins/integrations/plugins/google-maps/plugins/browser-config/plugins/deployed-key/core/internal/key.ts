import { defineDeploySecret } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/core";

/**
 * The browser key a DEPLOYED site draws its maps with (equin.ai's live demo):
 * a key of its own, restricted to the site's domains and to the Maps
 * JavaScript API, delivered to the box as an approved deploy secret — never
 * committed, never in a build or a demo snapshot. On the computer it is unset
 * and the host-global file answers (`machine/`). Public by design once in a
 * page; the deploy secret only keeps it out of git and asks before it ships.
 */
export const GOOGLE_MAPS_BROWSER_KEY = defineDeploySecret({
  key: "GOOGLE_MAPS_BROWSER_KEY",
  description:
    "The Google Maps browser key the deployed site draws its maps with: restricted to the site's domains (HTTP referrers) and to the Maps JavaScript API only.",
});

/**
 * The vector map's Map ID a deployed site draws with — the site's half of what
 * the computer keeps in its browser-config file beside the key. Not secret (it
 * is in every page that draws the map); delivered the same way as the key
 * because a deploy value is how a box receives anything that is not in git,
 * and per-user values stay out of git. Optional: unset, the site draws the
 * raster map. It must belong to the same Google Cloud project as
 * `GOOGLE_MAPS_BROWSER_KEY` (a JavaScript / Vector Map ID).
 */
export const GOOGLE_MAPS_MAP_ID = defineDeploySecret({
  key: "GOOGLE_MAPS_MAP_ID",
  description:
    "The Map ID the deployed site's maps draw with (vector map, its cloud style): a JavaScript / Vector Map ID in the same Google Cloud project as GOOGLE_MAPS_BROWSER_KEY. Optional — unset, the site draws the raster map.",
  optional: true,
});
