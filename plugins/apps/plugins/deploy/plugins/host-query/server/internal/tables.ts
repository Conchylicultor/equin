import { pgTable, timestamp } from "drizzle-orm/pg-core";
import { idRef } from "@plugins/ids/server";
import { _deployServers } from "@plugins/apps/plugins/deploy/plugins/servers/server";
import { deployServerIdKind } from "@plugins/apps/plugins/deploy/plugins/servers/core";

/**
 * Servers whose box is THIS instance (a demo's stand-in): their host-only
 * routes are answered by this instance's own gateway instead of over SSH. One
 * row per such server; it goes with the server.
 */
export const deployHostStandIns = pgTable("deploy_host_stand_ins", {
  serverId: idRef(deployServerIdKind, "server_id", () => _deployServers.id, {
    onDelete: "cascade",
  }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
