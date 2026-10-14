import {
  hasSecret,
  listKeysInNamespace,
} from "@plugins/infra/plugins/secrets/server";
import { _deployServers } from "./tables";
import { SSH_SECRET_NAMESPACE } from "./ssh-secret";
import { parseSshPublicKey } from "./ssh-public-key";
import type { Server, SshKey } from "../../shared";

// The single row→wire projection for this plugin. It was triplicated across
// handle-get / handle-list / handle-create / handle-update / resources.ts,
// which is exactly what `no-hand-rolled-entity-projection` exists to prevent
// and exactly what it cannot see: the rule only inspects a resource's
// `loader`, and even there the `await hasSecret(…)` in the old loader failed
// its purity check. `defineEntity` does not apply either — both derived fields
// here (a secrets lookup and a SHA-256) are computed, and `defineEntity`
// returns rows verbatim with no hook for a derived field.

export type ServerRow = typeof _deployServers.$inferSelect;

function sshKeyOf(sshPublicKey: string | null, hasPrivateKey: boolean) {
  // Both halves or nothing: the public key alone identifies a key we cannot
  // use, and a private key alone is a key we cannot name.
  return sshPublicKey && hasPrivateKey ? parseSshPublicKey(sshPublicKey) : null;
}

/**
 * Drift-safe by construction: the row is spread and only the transformed
 * column is destructured out, so a column added to `tables.ts` reaches the
 * wire as soon as `ServerSchema` names it.
 */
function buildServer(row: ServerRow, hasPrivateKey: boolean): Server {
  const { sshPublicKey, ...rest } = row;
  return { ...rest, sshKey: sshKeyOf(sshPublicKey, hasPrivateKey) };
}

/**
 * The key this app holds for one server — `Server.sshKey`, served on its own
 * (`serverSshKey`) so the registry list stays a plain column projection.
 */
export async function toSshKey(row: ServerRow): Promise<SshKey | null> {
  return sshKeyOf(
    row.sshPublicKey,
    await hasSecret({ namespace: SSH_SECRET_NAMESPACE, key: row.id }),
  );
}

export async function toServer(row: ServerRow): Promise<Server> {
  return buildServer(
    row,
    await hasSecret({ namespace: SSH_SECRET_NAMESPACE, key: row.id }),
  );
}

/**
 * One `listKeysInNamespace` round-trip to central for the whole list, not one
 * `hasSecret` per row. `deploy.servers` is a push resource whose loader re-runs
 * on every row update, so the per-row form cost N cross-process calls per
 * refresh.
 */
export async function toServers(rows: ServerRow[]): Promise<Server[]> {
  const withKeys = new Set(await listKeysInNamespace(SSH_SECRET_NAMESPACE));
  return rows.map((row) => buildServer(row, withKeys.has(row.id)));
}
