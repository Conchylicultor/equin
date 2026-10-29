import { defineRoute } from "@plugins/primitives/plugins/pane/core";
import { deployIndexRoute } from "@plugins/apps/plugins/deploy/plugins/shell/core";

/**
 * One site — a deployment: a composition served on a server under its
 * hostnames — as the app's primary page.
 *
 * The optional trailing `:tab?` is which tab of the site is on screen, so a
 * tab has an address while bare `site/<id>` stays valid (the Overview).
 * Parented on the app's index, not on the server it lives on: a site is
 * reached directly, and only its own id addresses it.
 *
 * Segments are GLOBALLY unique across all panes after param-name erasure.
 */
export const siteRoute = defineRoute({
  id: "deploy-site",
  segment: "site/:deploymentId/:tab?",
  parent: deployIndexRoute,
});
