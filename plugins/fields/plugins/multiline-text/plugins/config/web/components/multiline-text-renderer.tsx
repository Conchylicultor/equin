import {
  ConfigFieldContext,
  defineFieldShape,
} from "@plugins/config_v2/plugins/fields/web";
import { useContext } from "react";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { multilineTextFieldType } from "@plugins/fields/plugins/multiline-text/core";
import { Textarea } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { type MultilineTextFieldDef } from "../../core";

/** A textarea is wider than a row, so it is a `block` — the panel draws the
 *  label above it and the control lands on the panel's rail by doing nothing. */
const MultilineTextRenderer = defineFieldShape({
  type: multilineTextFieldType,
  useShape: ({ field, value, onChange }) => {
    const ctx = useContext(ConfigFieldContext);
    // Debounced autosave (flush on blur), like every other text field in the app.
    const draft = useEditableField({
      value,
      onSave: onChange,
      label: field.meta.label,
      // Unsaved text is kept per stored config field; a form outside the
      // config store (an event source's) has no stable record to key it by.
      keep: ctx
        ? {
            field: "fields.config-multiline-text",
            subject: `${ctx.storePath}|${ctx.fieldKey}|${field.meta.label ?? ""}`,
          }
        : transient("no config field around it: the host form owns the value"),
    });
    const rows = (field as MultilineTextFieldDef).rows ?? 4;
    return {
      kind: "block",
      control: (
        <Textarea
          bare
          keep={draft.keep}
          rows={rows}
          placeholder={field.meta.placeholder}
          onFocus={draft.onFocus}
          onBlur={draft.onBlur}
          className="focus-border w-full resize-y rounded-lg border border-input bg-transparent px-sm py-xs text-body placeholder:text-muted-foreground dark:bg-input/30"
        />
      ),
    };
  },
});

export { MultilineTextRenderer };
