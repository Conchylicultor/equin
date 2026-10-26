import type { TaskDraftActionProps } from "@plugins/tasks/plugins/task-draft-form/web";
import { serializeUiContext } from "@plugins/primitives/plugins/ui-context/core";
import { PickerButton } from "@plugins/primitives/plugins/ui-context/plugins/element-picker/web";

/**
 * Draft-form entry: pick an element and inject its `<ui-context/>` tag into the
 * head card at the caret. Pick several elements in a row and each lands as its
 * own chip, where the cursor was. The Improve-pill twin (`ElementPickerButton`)
 * reaches the same insertion path from outside the form.
 */
export function TaskDraftPickerButton({ insertText }: TaskDraftActionProps) {
  return (
    <PickerButton
      label="Attach UI element"
      onPick={(meta) => insertText(serializeUiContext(meta, "picked"))}
    />
  );
}
