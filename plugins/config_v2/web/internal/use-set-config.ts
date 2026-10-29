import { useCallback } from "react";
import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { setConfigField } from "../../core";
import type { ConfigDescriptor } from "../../core";
import type { FieldsRecord } from "@plugins/fields/core";
import { storePathOf } from "./store-path";
import { ConfigV2 } from "./slots";
import { announceRefusedWrite, useConfigPreview } from "./config-preview";

export function useSetConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  opts?: { scopeId?: string },
): (key: keyof F & string, value: unknown) => void {
  const registrations = useRawContributions(ConfigV2.WebRegister);
  // Predicted (`setConfigField`'s effect): every read of the document shows the
  // write at once, and a refused write unwinds with the rejection toast.
  // Called before the throw below to keep hook order unconditional.
  const { mutate } = useLiveMutation(setConfigField);
  const preview = useConfigPreview();
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
      // The preview shows the committed layer, read-only: a write would land
      // in the user's config, invisible behind the preview.
      if (preview) {
        announceRefusedWrite();
        return;
      }
      mutate({
        body: scopeId
          ? { storePath, key, value, scopeId }
          : { storePath, key, value },
      });
    },
    [mutate, storePath, scopeId, preview],
  );
}
