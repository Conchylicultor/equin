import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleList } from "./internal/handle-list";
import { handleGet } from "./internal/handle-get";
import { handleCreate } from "./internal/handle-create";
import { handleUpdate } from "./internal/handle-update";
import { handleDelete } from "./internal/handle-delete";
import { handleGenerateKeypair } from "./internal/handle-generate-keypair";
import { handleImportKeypair } from "./internal/handle-import-keypair";
import { backfillSshPublicKeys } from "./internal/backfill-ssh-public-keys";
import { serversServed, serverSshKeyServed } from "./internal/resources";
import {
  listServers,
  createServer,
  getServer,
  updateServer,
  deleteServer,
  generateSshKeypair,
  importSshPrivateKey,
} from "../shared/endpoints";
import { IdKinds } from "@plugins/ids/server";
import { deployServerIdKind } from "../core";

export { _deployServers } from "./internal/tables";
export { getServerSshPrivateKey } from "./internal/ssh-secret";

export default {
  description: "Server registry for the deployment platform.",
  httpRoutes: {
    [listServers.route]: handleList,
    [createServer.route]: handleCreate,
    [getServer.route]: handleGet,
    [updateServer.route]: handleUpdate,
    [deleteServer.route]: handleDelete,
    [generateSshKeypair.route]: handleGenerateKeypair,
    [importSshPrivateKey.route]: handleImportKeypair,
  },
  contributions: [
    IdKinds.Kind({ kind: deployServerIdKind }),
    ...serversServed.declare,
    ...serverSshKeyServed.declare,
  ],
  onReady: async () => {
    await backfillSshPublicKeys();
  },
} satisfies ServerPluginDefinition;
