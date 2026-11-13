import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import {
  useSnippetListEdit,
  type SnippetListEdit,
} from "@plugins/conversations/plugins/prompt-snippets/web";
import { prepromptsConfig } from "../../shared/config";

/**
 * Edit the preprompt library in place — the shared snippet editor over the
 * `preprompts` config list, so a picker can add, rename, rewrite and delete
 * preprompts without a trip to Settings. Fields the editor does not show (the
 * icon, inherit) start at their defaults on a new preprompt and are kept on an
 * edit.
 */
export function useEditPrepromptLibrary(opts?: {
  /** Called with a new preprompt's id once it is stored (the picker selects it). */
  onAdded?: (id: string) => void;
  /** Called with a deleted preprompt's id (the picker clears it if selected). */
  onRemoved?: (id: string) => void;
}): SnippetListEdit {
  const { preprompts } = useConfig(prepromptsConfig);
  const setConfig = useSetConfig(prepromptsConfig);
  const onAdded = opts?.onAdded;
  const { itemFields } = prepromptsConfig.fields.preprompts;
  return useSnippetListEdit({
    items: preprompts,
    onChange: (next) => setConfig("preprompts", next),
    // Everything but the name and prompt seeded from its field's default, as
    // Settings' Add seeds a row.
    create: (d) => ({
      ...d,
      icon: itemFields.icon.defaultValue,
      inherit: itemFields.inherit.defaultValue,
    }),
    onAdded: onAdded && ((item) => onAdded(item.id)),
    onRemoved: opts?.onRemoved,
  });
}
