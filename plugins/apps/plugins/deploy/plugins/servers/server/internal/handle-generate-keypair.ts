import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { generateSshKeypair } from "../../shared/endpoints";
import { _deployServers } from "./tables";
import { toServer } from "./project-server";
import { assertReplaceAllowed, generateServerSshKey } from "./store-ssh-key";
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

    return toServer(await generateServerSshKey(params.id));
  },
);
