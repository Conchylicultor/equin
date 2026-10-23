import { useCallback, type ReactNode } from "react";
import type { PropertyEntry } from "../../../core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  SortableItem,
  SortableList,
} from "@plugins/primitives/plugins/sortable-list/web";
import { usePropertiesController } from "../../internal/use-properties-controller";
import { FieldSections } from "../../internal/field-sections";
import { useDataViewControls } from "../controls/controls-context";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const visibilityIcon = symbol("visibility");
const hiddenIcon = symbol("visibility-off");

/**
 * Properties setting (a `view`-scope settings contribution): a per-view-instance
 * control governing which fields render in the view body and in what order
 * (Notion "Properties"). One stable, reorderable list of EVERY field, driven by
 * the `PropertiesController`, plus a "Show all fields" reset. Reads the field
 * schema + active-instance state from `DataViewControlsContext` and writes back
 * through `viewModel.setProperties` — no prop-threading, mirroring
 * `GroupByControl`. Renders nothing on a single-field surface (nothing to
 * configure); the contribution's `isApplicable` gates the panel on the same
 * condition so the gear never opens onto an empty section.
 *
 * Each row is one `ControlPanel.Row` with no drag handle: the whole row is the
 * drag activator (its `SortableItem` wrapper carries the listeners — a press
 * that moves under 4px stays a click, and dnd-kit swallows the click that ends
 * a drag), the row itself is the show / hide toggle, and the trailing cell is
 * the eye that says which (`visibility` / `visibility-off`). A hidden field stays
 * where it is, dimmed (`muted`), so showing it again puts it back in the same
 * place — the list's order is the body's, hidden fields included. The eye is
 * presentational (the row is the click target), so the hidden state is also
 * spelled out to screen readers in the label.
 *
 * "Show all fields" is the section's LAST ROW, not the panel's footer: a
 * contribution owns a section, not the panel, and a footer placed from inside one
 * section would sit above whatever contribution came next.
 *
 * A schema several plugins contributed to is drawn BAND BY BAND under its section
 * headings (`Common`, then each contributor's), with one `SortableList` per band
 * — so a drag reorders within its own source and cannot carry a build column into
 * the middle of the shared ones, which is the order the body then reads back.
 */
export function PropertiesControl(): ReactNode {
  const { fields, activeState, activeViewId, viewModel } =
    useDataViewControls();

  const setProperties = useCallback(
    (entries: PropertyEntry[] | null) =>
      viewModel.setProperties(activeViewId, entries),
    [viewModel, activeViewId],
  );
  const controller = usePropertiesController(
    fields,
    activeState.properties ?? null,
    setProperties,
  );

  if (fields.length <= 1) return null;

  return (
    <ControlPanel.Section label="Properties">
      <FieldSections fields={controller.items.map((i) => i.field)}>
        {(sectionFields) => {
          const ids = new Set(sectionFields.map((f) => f.id));
          const items = controller.items.filter((i) => ids.has(i.field.id));
          return (
            <SortableList
              items={items.map((i) => i.field.id)}
              orientation="vertical"
              // The drop index is read off the FULL list: `controller.move`
              // reorders the one flat order the body reads, and a drop inside
              // this band always lands inside it (each band is its own
              // `DndContext`, and `items` is band-contiguous).
              onMove={(activeId, overId) => {
                const toIndex = controller.items.findIndex(
                  (i) => i.field.id === overId,
                );
                if (toIndex !== -1) controller.move(activeId, toIndex);
              }}
            >
              {items.map((item) => (
                <SortableItem
                  key={item.field.id}
                  id={item.field.id}
                  className={({ isDragging }) => cn(isDragging && "opacity-40")}
                >
                  {() => (
                    <ControlPanel.Row
                      muted={!item.visible}
                      onSelect={() => controller.toggle(item.field.id)}
                      trailing={
                        <Icon
                          icon={item.visible ? visibilityIcon : hiddenIcon}
                        />
                      }
                    >
                      {item.field.label}
                      {!item.visible && (
                        <span className="sr-only"> (hidden)</span>
                      )}
                    </ControlPanel.Row>
                  )}
                </SortableItem>
              ))}
            </SortableList>
          );
        }}
      </FieldSections>
      <ControlPanel.Row
        icon={<Icon icon={visibilityIcon} />}
        muted
        disabled={!controller.isCustomized}
        onSelect={controller.showAll}
      >
        Show all fields
      </ControlPanel.Row>
    </ControlPanel.Section>
  );
}
