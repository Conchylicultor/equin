import { liveCollection } from "@plugins/network/plugins/live/core";
import { serverHealthShape } from "./schemas";

/**
 * Every server's last probe verdict, as a live collection over the
 * `deploy_servers_ext_health` side-table: rows key on `serverId` (the
 * extension's key, whose column is the side-table's `parent_id` PK). The server
 * half is served from the extension handle in `server/internal/resource.ts`.
 *
 * - **Every server at once** (the servers list's status column, the release
 *   column's platform lookup) reads the `:rows` point sibling for exactly the
 *   server ids it is displaying (`useServerHealthMap(serverIds)`), never the
 *   default window — a server past the window's rank would otherwise read as
 *   "never checked" even with a real verdict on file.
 * - **One server** reads `useLiveRow(serverHealthRows, serverId)`: a point
 *   read, so `found: false` is "never checked" — a determinate answer, where a
 *   pending read says nothing about the server at all.
 *
 * Named `…Rows` because `serverHealth` is the extension handle's name.
 */
export const serverHealthRows = liveCollection("deploy.server-health", {
  from: serverHealthShape,
  id: "serverId",
  sortable: ["checkedAt"],
  default: { orderBy: [["checkedAt", "desc"]], limit: 100 },
  maxLimit: 500,
});
