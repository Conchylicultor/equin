import { defineRoute } from "@plugins/primitives/plugins/pane/core";

// No `parent: deployIndexRoute`: the Deploy app lays its pages out as Miller
// columns, where a parent is drawn as a column — every page here is reached
// from the sidebar or the sites index and REPLACES what is on screen, so it is
// a root of its own (the index's segment is empty, so the URL is the same).

/** Every registered server, as a page of its own. */
export const serversRoute = defineRoute({
  id: "deploy-servers",
  segment: "servers",
});

/** One server — and, as `server/new`, the add form. */
export const serverDetailRoute = defineRoute({
  id: "deploy-server-detail",
  segment: "server/:serverId",
});
