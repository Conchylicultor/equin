import { defineRoute } from "@plugins/primitives/plugins/pane/core";
import { deployIndexRoute } from "@plugins/apps/plugins/deploy/plugins/shell/core";

/** Every registered server, as a page of its own. */
export const serversRoute = defineRoute({
  id: "deploy-servers",
  segment: "servers",
  parent: deployIndexRoute,
});

/** One server — and, as `server/new`, the add form. */
export const serverDetailRoute = defineRoute({
  id: "deploy-server-detail",
  segment: "server/:serverId",
  parent: deployIndexRoute,
});
