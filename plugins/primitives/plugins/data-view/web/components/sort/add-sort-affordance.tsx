import type { ReactNode } from "react";
import {
  ControlPanel,
  usePanelStack,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { useDataViewControls } from "../controls/controls-context";
import { FieldSearchList } from "../filter/field-search-list";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

/** The fields not yet sorted on — the only ones a new level can be added for. */
function useAddableFields() {
  const { sort } = useDataViewControls();
  const used = new Set(sort.rules.map((r) => r.fieldId));
  return { sort, addable: sort.sortableFields.filter((f) => !used.has(f.id)) };
}

/**
 * The `Add sort` row at the foot of the rule list. Clicking it PUSHES the
 * search-first field list as a page — it used to open an `InlinePopover`, i.e. a
 * popover from inside the panel's own popover, with a second width and a second
 * dismissal. Picking a field appends a level and walks back in one click.
 *
 * Renders nothing once every sortable field is already a level.
 */
export function AddSortRow(): ReactNode {
  const { addable } = useAddableFields();
  if (addable.length === 0) return null;

  return (
    <ControlPanel.Row
      icon={<Icon icon={addIcon} />}
      muted
      push={{
        key: "add-sort",
        title: "Add sort",
        size: "inherit",
        render: () => <AddSortPanel />,
      }}
    >
      Add sort
    </ControlPanel.Row>
  );
}

/**
 * The pushed page. It reads the controller itself rather than taking the field
 * list as a prop: a stack entry's `render` closure is captured at push time, so a
 * list passed in would be the one from the click, not the one from now.
 */
function AddSortPanel(): ReactNode {
  const { pop } = usePanelStack();
  const { sort, addable } = useAddableFields();

  return (
    <ControlPanel.Section>
      <FieldSearchList
        fields={addable}
        placeholder="Sort by…"
        onPick={(fieldId) => {
          pop();
          sort.addRule(fieldId);
        }}
      />
    </ControlPanel.Section>
  );
}
