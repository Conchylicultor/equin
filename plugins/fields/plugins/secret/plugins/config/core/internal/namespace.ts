import { defineSecretNamespace } from "@plugins/infra/plugins/secrets/core";

/**
 * The secrets namespace every secret config field's value lives in, keyed
 * `<descriptor name>.<field key>` (`google.clientSecret`). Machine-scoped: a
 * config field's API key is the user's, one value for every namespace.
 */
export const CONFIG_FIELD_SECRETS = defineSecretNamespace("config-fields", {
  scope: "machine",
});
