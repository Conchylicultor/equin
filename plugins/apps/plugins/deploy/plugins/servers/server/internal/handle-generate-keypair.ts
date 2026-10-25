import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { generateSshKeypair } from "../../shared/endpoints";
import { _deployServers } from "./tables";
import { toServer } from "./project-server";
import { generateEd25519Keypair } from "./ssh-keygen";
import { assertReplaceAllowed, storeSshKey } from "./store-ssh-key";
import { deployServerIdKind } from "../../core/id-kind";

export const handleGenerateKeypair = implement(
  generateSshKeypair,
  async ({ params, body }) => {
    const [row] = await db
      .select()
      .from(_deployServers)
      .where(eq(_deployServers.id, deployServerIdKind.key(params.id)));
    if (!row) throw new HttpError(404, "Not found");
    assertReplaceAllowed(row, body.replace);

    const keypair = await generateEd25519Keypair(
      `${LEGACY_IDS.deployKeyCommentPrefix}${params.id}`,
    );
    return toServer(await storeSshKey(params.id, keypair));
  },
);
