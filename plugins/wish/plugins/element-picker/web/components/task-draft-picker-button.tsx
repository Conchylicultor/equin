import {
  useDraftPage,
  type TaskDraftActionProps,
} from "@plugins/tasks/plugins/task-draft-form/web";
import {
  serializeUiContext,
  type UiContextMeta,
} from "@plugins/primitives/plugins/ui-context/core";
import { PickerButton } from "@plugins/primitives/plugins/ui-context/plugins/element-picker/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const LABEL = "Attach UI element";
const adsClickIcon = symbol("ads-click");

/**
 * Draft-form entry: pick an element and inject its `<ui-context/>` tag into the
 * head card at the caret. Pick several elements in a row and each lands as its
 * own chip, where the cursor was. The Improve-pill twin (`ElementPickerButton`)
 * reaches the same insertion path from outside the form.
 *
 * It picks on the page the draft is about (`useDraftPage`): this document in
 * place (the inspector overlay), a page elsewhere through its host's `pick()`,
 * and on a draft that can pick nothing (a companion about no page) it is not
 * offered at all.
 */
export function TaskDraftPickerButton({ insertText }: TaskDraftActionProps) {
  const { picker } = useDraftPage();
  const insert = (meta: UiContextMeta) =>
    insertText(serializeUiContext(meta, "picked"));
  if (picker === null) return null;
  if (picker.kind === "in-page")
    return <PickerButton label={LABEL} onPick={insert} />;
  const { pick } = picker;
  const pickRemote = async () => insert(await pick());
  return (
    <IconButton
      icon={adsClickIcon}
      label={LABEL}
      onClick={() => void pickRemote()}
    />
  );
}
