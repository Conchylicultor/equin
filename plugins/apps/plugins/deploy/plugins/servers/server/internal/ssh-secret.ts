import { getSecret } from "@plugins/infra/plugins/secrets/server";
import { defineSecretNamespace } from "@plugins/infra/plugins/secrets/core";

/**
 * The secrets namespace holding each server's SSH private key, keyed by server
 * id. Declared once here, beside the accessor, so no site in this plugin spells
 * the string a second time.
 */
export const SSH_SECRET_NAMESPACE = defineSecretNamespace("deploy-ssh", {
  scope: "instance",
});

/**
 * The server's SSH private key, as a discriminated result.
 *
 * `deploy-ssh` is this plugin's own secret namespace, and it stays that way: a
 * consumer that needs the key (the health probe) asks `servers` for it through
 * this named dependency instead of reaching into the namespace by string. An
 * absent key is a legitimate state (a server registered but not yet keyed), so
 * it is a discriminated `{ configured: false }` — never an absorbable
 * empty-string/null the caller could hand to an ssh client.
 */
export async function getServerSshPrivateKey(
  id: string,
): Promise<{ configured: true; privateKey: string } | { configured: false }> {
  const privateKey = await getSecret({
    namespace: SSH_SECRET_NAMESPACE,
    key: id,
  });
  return privateKey ? { configured: true, privateKey } : { configured: false };
}
