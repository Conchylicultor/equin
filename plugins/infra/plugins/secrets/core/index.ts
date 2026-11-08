export type {
  SecretRef,
  SecretMetadata,
  SecretNamespace,
  SecretScope,
  SecretWrite,
} from "./internal/types";
export { SECRET_HISTORY_LIMIT, SecretWriteSchema } from "./internal/types";
export {
  defineSecretNamespace,
  SECRETS_CALLER_HEADER,
} from "./internal/namespaces";
export {
  SecretsError,
  SecretsMainOfflineError,
  SecretsKeychainLockedError,
} from "./internal/errors";
export {
  secretsGet,
  secretsSet,
  secretsDelete,
  secretsHas,
  secretsMeta,
  secretsList,
} from "./endpoints";
