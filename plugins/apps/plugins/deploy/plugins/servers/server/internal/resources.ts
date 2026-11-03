import { sql } from "drizzle-orm";
import { expr } from "@plugins/network/plugins/live/plugins/query-resource/core";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { _deployServers } from "./tables";
import { toSshKey } from "./project-server";
import { deployServerIdKind } from "../../core/id-kind";
import {
  servers,
  serverSshKey,
  serverSshPublicKeys,
} from "../../shared/resources";

// The registry list: a plain column projection of `deploy_servers` (the
// collection's `pick` + `carry`), every field an extension exposes (health's
// probe verdict) folded in by the entity it reaches. A server write refills
// its row; an insert is an entrant, a delete an exit.
export const serversServed = serveCollection(servers, {
  from: _deployServers,
});

// Each server's stored public key, by id — the narrow row `serverSshKey`
// follows. `ssh_public_key` is a server field of the entity, so it binds as
// an expression naming the table's own column.
export const serverSshPublicKeysServed = serveCollection(serverSshPublicKeys, {
  from: _deployServers,
  columns: {
    sshPublicKey: () =>
      expr(sql`${_deployServers.sshPublicKey}`, {
        decoder: String,
        sqlType: "text",
        serverOnly: [_deployServers.sshPublicKey],
      }),
  },
});

// One server's key, derived: the stored public key parsed, only when a
// private half exists in the central secrets store. It follows the server's
// `ssh_public_key` row; storing a key also writes that column
// (`store-ssh-key.ts`), and that update is the change the feed sees — so a
// key change needs no hand-notify, and another server's write reaches none.
export const serverSshKeyServed = serveValue(serverSshKey, {
  source: "db",
  follows: (follow) => ({
    server: follow(serverSshPublicKeysServed, ({ serverId }) => ({
      ids: [deployServerIdKind.key(serverId)],
    })),
  }),
  loader: async (_params, { followed }) => {
    const row = followed.server[0];
    return row
      ? toSshKey({ id: row.id, sshPublicKey: row.sshPublicKey })
      : null;
  },
});
