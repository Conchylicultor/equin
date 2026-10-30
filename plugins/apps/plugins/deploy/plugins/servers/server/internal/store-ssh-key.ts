import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { setSecret } from "@plugins/infra/plugins/secrets/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { _deployServers } from "./tables";
import { type ServerRow } from "./project-server";
import { SSH_SECRET_NAMESPACE } from "./ssh-secret";
import { deployServerIdKind } from "../../core/id-kind";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { generateEd25519Keypair } from "./ssh-keygen";

/**
 * Give a server a fresh ed25519 key — Generate key's write: the pair made on
 * this machine, the private half into the secrets store, the public half on
 * the row. No replace guard: a caller replacing a key decides that first.
 */
export async function generateServerSshKey(
  serverId: string,
): Promise<ServerRow> {
  const keypair = await generateEd25519Keypair(
    `${LEGACY_IDS.deployKeyCommentPrefix}${serverId}`,
  );
  return storeSshKey(serverId, keypair);
}

/**
 * The tail every key-write path shares: stash the private half, then record the
 * public half on the row.
 *
 * The ordering is load-bearing. `setSecret` first means that if the secrets
 * store is unreachable the column stays NULL, so the row never advertises a key
 * we do not hold — the reverse order would produce exactly the "configured but
 * unusable" state this whole design exists to make unrepresentable. The row
 * update is also what fires the change-feed push refreshing `deploy.servers`;
 * the secret write alone is invisible to it — so the UPDATE runs even when the
 * public key is unchanged (the change feed fires per statement; the derived
 * `updatedAt` then simply stays put).
 */
export async function storeSshKey(
  serverId: string,
  key: { privateKey: string; publicKey: string },
): Promise<ServerRow> {
  await setSecret(
    { namespace: SSH_SECRET_NAMESPACE, key: serverId },
    key.privateKey,
  );
  const [row] = await db
    .update(_deployServers)
    .set({ sshPublicKey: key.publicKey })
    .where(eq(_deployServers.id, deployServerIdKind.key(serverId)))
    .returning();
  if (!row) throw new HttpError(404, "Not found");
  return row;
}

/**
 * Guards a destructive key write behind an explicit `replace`.
 *
 * Keyed on the column rather than `hasSecret`: it is cheaper, it agrees with
 * what the UI shows, and it means a legacy *unusable* stored key (pasted before
 * validation existed, so never derived) no longer 409-blocks the user out of
 * generating a working one.
 */
export function assertReplaceAllowed(row: ServerRow, replace?: boolean): void {
  if (row.sshPublicKey !== null && !replace) {
    throw new HttpError(
      409,
      "An SSH key is already configured for this server. Pass replace: true to overwrite it.",
    );
  }
}
