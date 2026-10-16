import type { ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { useFilterEditor } from "../../internal/use-filter-editor";
import { AddGroupRow } from "./add-filter-affordance";
import { FieldSearchList } from "./field-search-list";
import { FilterGroupPanel } from "./filter-group-panel";
import { useFilterPanelStack } from "./filter-scope";
import { FilterPresetSection, FilterSavePresetPanel } from "./presets";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const bookmarkAddIcon = symbol("bookmark-add");
const closeIcon = symbol("close");

/**
 * The filter control's panel body. Prop-less by contract — it reads the live
 * tree off `useFilterEditor()`, which reads the controller off
 * `useDataViewControls()`.
 *
 * With no rules yet it IS the search-first field list ("Filter by…" typeahead
 * over the schema fields): picking a field adds a rule in one click, and the
 * grouped path sits below the list. The tree materializes from a transient empty
 * root on that first edit, so opening with no filter commits nothing.
 *
 * Once populated it is the root group's page — the rule list plus its own
 * `Add filter` row — over a footer of Save-as-preset / Clear-filter ROWS. The
 * footer used to be two ghost buttons pushed to opposite corners, the left one
 * opening a popover inside the popover.
 */
export function FilterControlPanel(): ReactNode {
  return <FilterEditorPanel presets clearLabel="Clear filter" />;
}

/**
 * The filter builder's body, over whichever tree `useFilterEditor()` reads — the
 * view's filter, or (inside a `FilterScope`) another `FilterGroup` such as the
 * fold rule's `keep`. `presets` draws the saved-preset section and the
 * "Save as preset" row: presets belong to the VIEW's filter, so a scoped editor
 * turns them off rather than offering to save a fold rule as a filter preset.
 */
export function FilterEditorPanel({
  presets,
  clearLabel,
}: {
  presets: boolean;
  clearLabel: string;
}): ReactNode {
  const editor = useFilterEditor();
  const { push } = useFilterPanelStack();
  const hasContent = editor.root.children.length > 0;

  return (
    <>
      {presets ? <FilterPresetSection /> : null}

      {hasContent ? (
        <>
          <FilterGroupPanel groupId={editor.root.id} />
          <ControlPanel.Footer>
            {presets ? (
              <ControlPanel.Row
                icon={<Icon icon={bookmarkAddIcon} />}
                onSelect={() =>
                  push({
                    key: "save-filter-preset",
                    title: "Save as preset",
                    size: "inherit",
                    render: () => <FilterSavePresetPanel />,
                  })
                }
              >
                Save as preset
              </ControlPanel.Row>
            ) : null}
            {/* Clearing leaves the panel OPEN, on the field picker it started
                from. The panel is no longer the owner of its own popover — it is
                a prop-less body the toolbar mounts, and in the compact fold there
                is no popover to close at all — so "clear and dismiss" is not one
                gesture it can express in both layouts. */}
            <ControlPanel.Row
              icon={<Icon icon={closeIcon} />}
              tone="danger"
              onSelect={editor.clear}
            >
              {clearLabel}
            </ControlPanel.Row>
          </ControlPanel.Footer>
        </>
      ) : (
        <ControlPanel.Section>
          <FieldSearchList
            fields={editor.fields}
            onPick={(fieldId) =>
              editor.addRuleForField(editor.root.id, fieldId)
            }
            footer={
              <AddGroupRow onClick={() => editor.addGroup(editor.root.id)} />
            }
          />
        </ControlPanel.Section>
      )}
    </>
  );
}
