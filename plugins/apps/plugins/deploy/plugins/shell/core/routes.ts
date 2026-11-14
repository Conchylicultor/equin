import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The Deploy app's index route — the sites index, what bare `/deploy`
 * resolves to. It owns no URL segment of its own, so it contributes nothing to
 * the path. No deeper deploy route (a site, the servers list, a server, the
 * activity) is parented on it: the app draws its pages as Miller columns, where
 * a parent is a column, and each page REPLACES the one on screen.
 *
 * It lives in the shell rather than in the plugin whose pane sits on it so
 * neither `deployments` nor `servers` has to import the other for it.
 */
export const deployIndexRoute = defineRoute({
  id: "deploy-index",
  segment: "",
});
