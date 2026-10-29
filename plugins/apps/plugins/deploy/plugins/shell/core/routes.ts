import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The Deploy app's index route — the sites index, what bare `/deploy`
 * resolves to. It owns no URL segment of its own, so it contributes nothing to
 * the path; it is the parent every deeper deploy route (a site, the servers
 * list, a server) chains from.
 *
 * It lives in the shell rather than in the plugin whose pane sits on it so the
 * feature plugins parent on the APP, not on each other: `deployments` and
 * `servers` both chain from here, and neither's routes import the other's.
 */
export const deployIndexRoute = defineRoute({
  id: "deploy-index",
  segment: "",
});
