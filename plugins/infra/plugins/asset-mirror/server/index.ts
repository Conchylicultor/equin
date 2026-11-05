import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { getMirroredFile, getMirroredNestedFile } from "../core";
import { handleMirror } from "./internal/handle-mirror";

export { defineAssetMirror } from "./internal/registry";
export type { AssetMirrorSpec } from "./internal/registry";
export { assetMirrorFiles } from "./internal/roots";

export default {
  description:
    "Generic asset mirror, on every host: plugins declare a remote asset source via defineAssetMirror; GET /api/asset-mirror/:id/:file (and /:id/:dir/:file) downloads each file on its first request into the assetMirrorFiles data-files root and serves it same-origin thereafter — offline-capable after one warm-up on the desktop (the computer's disk, shared by every worktree), once per browser profile in a browser host (its data-files store, kept in the host's storage).",
  httpRoutes: {
    [getMirroredFile.route]: rawEndpointHandler(getMirroredFile, handleMirror),
    [getMirroredNestedFile.route]: rawEndpointHandler(
      getMirroredNestedFile,
      handleMirror,
    ),
  },
} satisfies ServerPluginDefinition;
