import {
  liveCollection,
  liveValue,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { deployServersEntityRef } from "../core";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
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
      // Measured on main, 2026-11-08: 1.
      budget: 20,
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

/**
 * Each server's stored public key, by id — the follow target of
 * `serverSshKey` (lookup-only: `:rows` alone). The row is exactly what the
 * key derives from, so only a write to `ssh_public_key` (storing or
 * replacing a key) reaches a follower; a rename, a port change or another
 * server's key reaches none. `sshPublicKey` is a server field of the entity
 * (never on the ref), carried here as its own field: the public half only,
 * which the derived `SshKey` names anyway.
 */
export const serverSshPublicKeys = liveCollection(
  "deploy.server-ssh-public-keys",
  {
    from: deployServersEntityRef,
    carry: {
      pick: ["id"],
      fields: { sshPublicKey: nullable(textField()) },
    },
    baseExposures: false,
    id: "id",
  },
);
