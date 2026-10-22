import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * One attachment's bytes. In core because the browser loads it as an asset
 * (`assetPath(getAttachmentFile, { id })`, the `AssetPath` an attachment's
 * thumbnail, chip or link resolves through `useAssetSrc`), as well as reads it
 * with `fetchEndpoint`.
 */
export const getAttachmentFile = defineEndpoint({
  route: "GET /api/attachments/:id",
  response: blob(),
});
