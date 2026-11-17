import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * This account's gateway port record (`port.json`). Its own dir rather than a
 * file in `state/gateway/` because that one is reclaimable at restart, and this
 * is the only copy of a choice bookmarks, OAuth redirect URIs and the menu-bar
 * helper depend on.
 */
export const gatewayPortDir = defineDataDir({
  kind: "state",
  name: "gateway-port",
  owner: "infra/launcher/gateway-port",
  description:
    "This account's gateway port (port.json): the first free one of 8700…8709, chosen once and kept",
  reclaim: {
    kind: "never",
    reason:
      "the only record of the port this account's bookmarks, OAuth redirect URIs and the menu-bar helper point at",
  },
});

export {
  gatewayOriginSync,
  gatewayPortFile,
  gatewayPortSync,
  readGatewayPortRecordSync,
} from "./internal/sync-port";

export default [gatewayPortDir];
