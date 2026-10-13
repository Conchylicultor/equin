import { useCallback } from "react";
import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { setConfigField } from "../../core";
import type { ConfigDescriptor } from "../../core";
import type { FieldsRecord } from "@plugins/fields/core";
import { storePathOf } from "./store-path";
import { ConfigV2 } from "./slots";

export function useSetConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  opts?: { scopeId?: string },
): (key: keyof F & string, value: unknown) => void {
  const registrations = useRawContributions(ConfigV2.WebRegister);
  // useEndpointMutation (not void fetchEndpoint) so a failed save surfaces via
  // the global error toast instead of escaping as an unhandled rejection.
  // Called before the throw below to keep hook order unconditional.
  const { mutate } = useEndpointMutation(setConfigField);
  const reg = registrations.find((c) => c.descriptor === descriptor);
  const storePath = reg ? storePathOf(reg) : null;

  if (!storePath) {
    throw new Error(
      `[config-v2] useSetConfig: descriptor "${descriptor.name}" has no web registration. ` +
        `Add ConfigV2.WebRegister({ descriptor }) to your plugin's web contributions.`,
    );
  }

  const scopeId = opts?.scopeId;

  return useCallback(
    (key: keyof F & string, value: unknown) => {
      mutate({
        body: scopeId
          ? { storePath, key, value, scopeId }
          : { storePath, key, value },
      });
    },
    [mutate, storePath, scopeId],
  );
}
