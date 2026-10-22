import {
  getSecret,
  setSecret,
  deleteSecret,
  getSecretMetadata,
} from "@plugins/infra/plugins/secrets/server";
import { SecretsMainOfflineError } from "@plugins/infra/plugins/secrets/core";
import type { FieldStorageProvider } from "@plugins/config_v2/server";
import { getAllDescriptors } from "@plugins/config_v2/server";
import { configSecretMetaServed } from "./resource";

const NAMESPACE = "config-fields";

function secretKey(descriptorName: string, fieldKey: string): string {
  return `${descriptorName}.${fieldKey}`;
}

function findStorePath(descriptorName: string): string | undefined {
  for (const [path, desc] of getAllDescriptors()) {
    if (desc.name === descriptorName) return path;
  }
  return undefined;
}

export const secretStorageProvider: FieldStorageProvider = {
  async load(descriptorName, fieldKey) {
    try {
      const key = secretKey(descriptorName, fieldKey);
      const ref = { namespace: NAMESPACE, key };
      const value = await getSecret(ref);
      const meta = await getSecretMetadata(ref);
      return { value: value ?? "", set: meta.set };
    } catch (err) {
      if (err instanceof SecretsMainOfflineError) {
        return { value: "", set: false };
      }
      throw err;
    }
  },

  async save(descriptorName, fieldKey, value) {
    await setSecret(
      { namespace: NAMESPACE, key: secretKey(descriptorName, fieldKey) },
      value,
    );
    const path = findStorePath(descriptorName);
    if (path) configSecretMetaServed.notify({ path });
  },

  async clear(descriptorName, fieldKey) {
    await deleteSecret({
      namespace: NAMESPACE,
      key: secretKey(descriptorName, fieldKey),
    });
    const path = findStorePath(descriptorName);
    if (path) configSecretMetaServed.notify({ path });
  },
};
