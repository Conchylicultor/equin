import type { ReactNode } from "react";
import {
  ControlPanel,
  usePanelStack,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { useFilterEditor } from "../../internal/use-filter-editor";
import { FieldSearchList } from "./field-search-list";
import { useFilterPanelStack } from "./filter-scope";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const accountTreeIcon = symbol("account-tree");

/**
 * The `Add filter` row at the foot of a group's rule list. Clicking it PUSHES the
 * search-first field list as a page: picking a field adds a rule on it and walks
 * back in one click, and the advanced "Add filter group" path sits at the bottom
 * of that list.
 *
 * It used to be a ghost button opening an `InlinePopover` — a popover from inside
 * the panel's own popover, with a second width, a second clamp and a second
 * dismissal.
 */
export function AddFilterRow({ groupId }: { groupId: string }): ReactNode {
  const { push } = useFilterPanelStack();
  return (
    <ControlPanel.Row
      icon={<Icon icon={addIcon} />}
      muted
      onSelect={() =>
        push({
          key: `add-filter:${groupId}`,
          title: "Add filter",
          render: () => <AddFilterPanel groupId={groupId} />,
        })
      }
    >
      Add filter
    </ControlPanel.Row>
  );
}

/**
 * The pushed page. It reads the editor itself rather than taking the field list
 * and the edit callbacks as props: a stack entry's `render` closure is captured
 * at push time, so anything handed in would be from the click, not from now.
 */
function AddFilterPanel({ groupId }: { groupId: string }): ReactNode {
  const editor = useFilterEditor();
  const { pop } = usePanelStack();

  return (
    <ControlPanel.Section needs="builder">
      <FieldSearchList
        fields={editor.fields}
        onPick={(fieldId) => {
          pop();
          editor.addRuleForField(groupId, fieldId);
        }}
        footer={
          <AddGroupRow
            onClick={() => {
              pop();
              editor.addGroup(groupId);
            }}
          />
        }
      />
    </ControlPanel.Section>
  );
}

/**
 * The "Add filter group" advanced row, shared by the pushed add page and the
 * empty-state field list so both expose the grouped-filter path identically below
 * the field list. A `ControlPanel.Row` like the fields above it, so it highlights
 * and sizes as one of them. It draws no divider above itself: the one it used to
 * borrow from the dropdown menu is exactly the hand-placed separator this pass
 * removes.
 */
export function AddGroupRow(props: { onClick: () => void }): ReactNode {
  return (
    <ControlPanel.Row
      icon={<Icon icon={accountTreeIcon} />}
      onSelect={props.onClick}
    >
      Add filter group
    </ControlPanel.Row>
  );
}
