import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * One site — a deployment: a composition served on a server under its
 * hostnames — as the app's primary page.
 *
 * The optional trailing `:tab?` is which tab of the site is on screen, so a
 * tab has an address while bare `site/<id>` stays valid (the Overview).
 * A root of its own — parented neither on the server it lives on (a site is
 * reached directly, and only its own id addresses it) nor on the app's index:
 * the Deploy app draws its pages as Miller columns, where a parent is a column,
 * and opening a site from the sidebar or the sites index replaces the page on
 * screen rather than opening beside it.
 *
 * Segments are GLOBALLY unique across all panes after param-name erasure.
 */
export const siteRoute = defineRoute({
  id: "deploy-site",
  segment: "site/:deploymentId/:tab?",
});
