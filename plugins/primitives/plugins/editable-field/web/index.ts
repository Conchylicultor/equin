import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useEditableField } from "./use-editable-field";
export type {
  EditableField,
  EditableFieldConflict,
  UseEditableFieldOptions,
} from "./use-editable-field";

export default {
  description:
    "Debounced-autosave field hook with focus tracking, flush-on-blur, and self-echo suppression. Its required keep ({ field, subject } or transient) keeps unsaved text as kept-state work until the save is acked: a remount restores it and resumes the save (or reports a conflict if the source moved on). Bind inputs with keep={field.keep}. Used by task/agent detail forms.",
  contributions: [],
} satisfies PluginDefinition;
