import type { ConfigDescriptor, ConfigValues } from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { getSecret } from "@plugins/infra/plugins/secrets/central";
import { CONFIG_FIELD_SECRETS } from "../../core";

export async function readSecretConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
): Promise<ConfigValues<F>> {
  const result = { ...descriptor.defaults } as Record<string, unknown>;
  for (const [key, field] of Object.entries(descriptor.fields)) {
    if (field.type.id === "secret") {
      const v = await getSecret({
        namespace: CONFIG_FIELD_SECRETS,
        key: `${descriptor.name}.${key}`,
      });
      result[key] = v ?? "";
    }
  }
  return result as ConfigValues<F>;
}
