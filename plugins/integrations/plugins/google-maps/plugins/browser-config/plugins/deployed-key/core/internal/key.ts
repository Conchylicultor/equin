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
