import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { _deployServers } from "./tables";
import { toSshKey } from "./project-server";
import { deployServerIdKind } from "../../core/id-kind";
import { servers, serverSshKey } from "../../shared/resources";

// The registry list: a plain column projection of `deploy_servers` (the
// collection's `pick` + `carry`), every field an extension exposes (health's
// probe verdict) folded in by the entity it reaches. A server write refills
// its row; an insert is an entrant, a delete an exit.
export const serversServed = serveCollection(servers, {
  from: _deployServers,
});

// One server's key, derived: the stored public key parsed, only when a
// private half exists in the central secrets store. The loader's read of the
// row routes its changes here; storing a key also writes the row's
// `ssh_public_key` (`store-ssh-key.ts`), and that update is the change the
// feed sees — so a key change needs no hand-notify.
export const serverSshKeyServed = serveValue(serverSshKey, {
  source: "db",
  loader: async ({ serverId }) => {
    const [row] = await db
      .select()
      .from(_deployServers)
      .where(eq(_deployServers.id, deployServerIdKind.key(serverId)));
    return row ? toSshKey(row) : null;
  },
});
