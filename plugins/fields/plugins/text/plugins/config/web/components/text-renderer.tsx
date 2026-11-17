import {
  ConfigFieldContext,
  defineFieldShape,
} from "@plugins/config_v2/plugins/fields/web";
import { useContext } from "react";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { textFieldType } from "@plugins/fields/plugins/text/core";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * `useShape` is a hook, so the draft lives here: the same debounced autosave
 * (flush on blur, external writes adopted or reported) as every other text
 * field in the app, rather than a save that only happens on blur.
 */
const TextRenderer = defineFieldShape({
  type: textFieldType,
  useShape: ({ field, value, onChange }) => {
    const ctx = useContext(ConfigFieldContext);
    const draft = useEditableField({
      value,
      onSave: onChange,
      label: field.meta.label,
      // Unsaved text is kept per stored config field; a form outside the
      // config store (an event source's) has no stable record to key it by.
      keep: ctx
        ? {
            field: "fields.config-text",
            subject: `${ctx.storePath}|${ctx.fieldKey}|${field.meta.label ?? ""}`,
          }
        : transient("no config field around it: the host form owns the value"),
    });
    return {
      kind: "value",
      fit: "field",
      control: (
        <Input
          keep={draft.keep}
          placeholder={field.meta.placeholder}
          onFocus={draft.onFocus}
          onBlur={draft.onBlur}
        />
      ),
    };
  },
});

export { TextRenderer };
