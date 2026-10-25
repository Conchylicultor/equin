import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _deployServers } from "./tables";
import { getServerSshPrivateKey } from "./ssh-secret";
import { derivePublicKey } from "./ssh-keygen";
import { InvalidSshKeyError } from "./ssh-key-error";
import { storeSshKey } from "./store-ssh-key";

/**
 * Recovers the public half of keys pasted before validation existed, so a row
 * that holds a usable private key can name it.
 *
 * Eager rather than lazy on purpose: the derived value has to be there the
 * FIRST time the page renders, or precisely the users with the problem (a
 * pasted key and a NULL column) see "No key" until they touch something —
 * reintroducing the confusion this change exists to remove. The `IS NULL` guard
 * makes every later boot a zero-row no-op, so a job + warm-up would be more
 * machinery than the work it schedules.
 *
 * A key we still cannot use (passphrase-protected, or not a key at all) keeps
 * its NULL column and the UI keeps saying "No key" — which is honest, and lets
 * the user generate over it since `assertReplaceAllowed` keys on the column.
 */
export async function backfillSshPublicKeys(): Promise<void> {
  const rows = await db
    .select({ id: _deployServers.id })
    .from(_deployServers)
    .where(isNull(_deployServers.sshPublicKey));

  for (const row of rows) {
    const secret = await getServerSshPrivateKey(row.id);
    if (!secret.configured) continue;
    try {
      const publicKey = await derivePublicKey(
        secret.privateKey,
        `${LEGACY_IDS.deployKeyCommentPrefix}${row.id}`,
      );
      await storeSshKey(row.id, { privateKey: secret.privateKey, publicKey });
    } catch (err) {
      if (!(err instanceof InvalidSshKeyError)) throw err;
      console.warn(
        `[deploy-servers] cannot derive a public key for ${row.id} (${err.reason}): ${err.message}`,
      );
    }
  }
}
