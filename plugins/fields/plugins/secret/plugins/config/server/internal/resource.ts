import { serveValue } from "@plugins/network/plugins/live/server";
import { getSecretMetadata } from "@plugins/infra/plugins/secrets/server";
import { SecretsMainOfflineError } from "@plugins/infra/plugins/secrets/core";
import {
  getAllDescriptors,
  hasFieldStorageProvider,
} from "@plugins/config_v2/server";
import { configSecretMeta } from "../../core";
import type { ConfigV2SecretMeta } from "../../core";

// External: the truth is the central secrets store. `storage.ts` notifies the
// descriptor's path after every save / clear.
export const configSecretMetaServed = serveValue(configSecretMeta, {
  source: "external",
  changes: "notified",
  loader: async ({ path }) => {
    const allDescriptors = getAllDescriptors();
    const entry = allDescriptors.find(([p]) => p === path);
    // An unregistered path is a bug in the reader (a reader with no path yet
    // skips the read — `useLive(configSecretMeta, null)`): fail loudly rather
    // than answer "no secret fields" for a descriptor that does not exist.
    if (!entry) {
      throw new Error(
        `[config-v2] no descriptor registered for secret-meta path "${path}"`,
      );
    }
    const [, descriptor] = entry;
    const result: ConfigV2SecretMeta = {};
    for (const [key, field] of Object.entries(descriptor.fields)) {
      if (!hasFieldStorageProvider(field.type.id)) continue;
      try {
        const meta = await getSecretMetadata({
          namespace: "config-fields",
          key: `${descriptor.name}.${key}`,
        });
        result[key] = meta;
      } catch (err) {
        if (err instanceof SecretsMainOfflineError) {
          result[key] = { set: false };
        } else {
          throw err;
        }
      }
    }
    return result;
  },
});
