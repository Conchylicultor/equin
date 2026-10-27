import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";
import { onReady } from "./internal/boot";
import {
  handleDelete,
  handleGet,
  handleHas,
  handleList,
  handleMeta,
  handleSet,
} from "./internal/handlers";
import {
  secretsGet,
  secretsSet,
  secretsDelete,
  secretsHas,
  secretsMeta,
  secretsList,
} from "@plugins/infra/plugins/secrets/core";

export {
  getSecret,
  setSecret,
  deleteSecret,
  hasSecret,
  getSecretMetadata,
  listKeysInNamespace,
} from "./internal/api";
export { ready } from "./internal/boot";
export type {
  SecretRef,
  SecretMetadata,
} from "@plugins/infra/plugins/secrets/core";
export {
  SecretsError,
  SecretsKeychainLockedError,
} from "@plugins/infra/plugins/secrets/core";

export default {
  description:
    "Encrypted key-value primitive. AES-256-GCM blob at ~/.equin/state/secrets/secrets.json.enc with the master key in the OS keychain (fallback to the .key beside it). Hosted on the central runtime; consumers (auth, config) call /api/secrets/* via the gateway.",
  loadBearing: true,
  httpRoutes: {
    [secretsGet.route]: handleGet,
    [secretsSet.route]: handleSet,
    [secretsDelete.route]: handleDelete,
    [secretsHas.route]: handleHas,
    [secretsMeta.route]: handleMeta,
    [secretsList.route]: handleList,
  },
  onReady,
} satisfies CentralPluginDefinition;
