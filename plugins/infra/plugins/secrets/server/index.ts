import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  SecretStore,
  getSecret,
  setSecret,
  deleteSecret,
  hasSecret,
  getSecretMetadata,
  listKeysInNamespace,
} from "./internal/store";
export type { SecretStoreImpl } from "./internal/store";
export { ready } from "./internal/ready";
export type { SecretRef, SecretMetadata } from "@plugins/infra/plugins/secrets/core";
export {
  SecretsError,
  SecretsMainOfflineError,
  SecretsKeychainLockedError,
} from "@plugins/infra/plugins/secrets/core";

export default {
  description:
    "The secrets API every backend calls (getSecret / setSecret / deleteSecret / hasSecret / getSecretMetadata / listKeysInNamespace), through the SecretStore host service (secrets.store) — provided on the computer by the machine half, a client of central's store. No browser host provides it, so nothing that reads secrets runs in one.",
  loadBearing: true,
} satisfies ServerPluginDefinition;
