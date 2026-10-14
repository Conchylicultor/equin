import {
  liveCollection,
  liveValue,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { deployServersEntityRef } from "../core";
import { SshKeySchema } from "./schemas";

/**
 * The server registry: every registered server, oldest first — a whole-set
 * collection over the `deploy_servers` entity, so the list DERIVES its fields
 * (the name, plus every field an extension of the entity exposes — `health`'s
 * probe verdict as `status`). The row carries the rest of the record (`carry`)
 * for the detail pane, the address column and the pickers; the key is read per
 * server below.
 *
 * Keyed `deploy.servers.all`, not the old value's `deploy.servers`: that value's
 * rows carried the derived `sshKey`, so a tab on an older bundle subscribing the
 * old key must not parse these.
 */
export const servers = liveCollection("deploy.servers.all", {
  from: deployServersEntityRef,
  pick: ["name"],
  carry: {
    pick: [
      "id",
      "host",
      "port",
      "sshUser",
      "consoleUrl",
      "createdAt",
      "updatedAt",
    ],
  },
  id: "id",
  all: {
    orderBy: [["createdAt", "asc"]],
    unbounded: {
      reason:
        "the hand-registered server registry (a handful of boxes); the list, the pickers and the deploy surfaces read every one",
    },
  },
});

/** One row of the registry list (`servers`): the record without its derived key. */
export type ServerListRow =
  typeof servers extends LiveRowsCollection<infer R> ? R : never;

/**
 * The SSH key this app holds for ONE server (null: none we can name). A value
 * keyed by server id rather than a column of `servers`: it is DERIVED — the
 * stored public key parsed, and only when a private half exists in the central
 * secrets store — which a column projection cannot express. No placeholder:
 * before the first value lands the read is `pending`, never "no key".
 */
export const serverSshKey = liveValue("deploy.server-ssh-key", {
  params: ["serverId"],
  schema: SshKeySchema.nullable(),
});
