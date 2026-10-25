import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { createServer } from "../../shared/endpoints";
import { _deployServers } from "./tables";
import { deployServerIdKind } from "../../core/id-kind";
import { toServer } from "./project-server";
import { derivePublicKey } from "./ssh-keygen";
import { rejectInvalidKey } from "./ssh-key-error";
import { storeSshKey } from "./store-ssh-key";

export const handleCreate = implement(createServer, async ({ body }) => {
  if (!body.host) {
    throw new HttpError(400, "host is required");
  }
  const id = deployServerIdKind.mint();

  // Derive BEFORE the insert, so a key the user got wrong is a 400 and not a
  // half-created server. The id is minted up front because the derived line
  // carries it as the authorized_keys comment.
  const publicKey = body.sshPrivateKey
    ? await derivePublicKey(
        body.sshPrivateKey,
        `${LEGACY_IDS.deployKeyCommentPrefix}${id}`,
      ).catch(rejectInvalidKey)
    : undefined;

  const [row] = await db
    .insert(_deployServers)
    .values({
      id,
      name: body.name || body.host,
      host: body.host,
      port: body.port ?? 22,
      sshUser: body.sshUser ?? "root",
      consoleUrl: body.consoleUrl || null,
    })
    .returning();
  if (!row) throw new HttpError(500, "insert returned no row");

  if (body.sshPrivateKey && publicKey) {
    return toServer(
      await storeSshKey(id, { privateKey: body.sshPrivateKey, publicKey }),
    );
  }
  return toServer(row);
});
