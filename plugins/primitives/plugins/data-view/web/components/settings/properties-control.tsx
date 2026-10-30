import { Fragment, useCallback, type ReactNode } from "react";
import {
  SLOTS,
  type FieldDef,
  type PropertyEntry,
  type Slot,
  type ViewSlots,
} from "../../../core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  usePanelStack,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  SortableItem,
  SortableList,
} from "@plugins/primitives/plugins/sortable-list/web";
import {
  usePropertiesController,
  type PropertiesController,
  type PropertyItem,
} from "../../internal/use-properties-controller";
import { usePlacement } from "../../internal/use-placement";
import type { Placement } from "../../internal/placement";
import { FieldSections } from "../../internal/field-sections";
import { useDataViewControls } from "../controls/controls-context";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const visibilityIcon = symbol("visibility");
const hiddenIcon = symbol("visibility-off");
const moveIcon = symbol("open-with");
const resetIcon = symbol("restart-alt");

/** What each slot is called in the editor. */
const SLOT_LABELS: Record<Slot, string> = {
  lead: "Lead",
  title: "Title",
  afterTitle: "After title",
  line2: "Second line",
  trail: "Trailing",
  edge: "Edge",
  hidden: "Hidden",
};

/** A view placing no fields by slot: the editor shows one band per source. */
const NO_SLOTS: ViewSlots = {};

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
 * a drag), and both the row and its eye button (`visibility` /
 * `visibility-off`) toggle show / hide. The eye is a real row action — a
 * presentational `trailing` glyph sits outside the row's click target once the
 * row carries actions, which is how it once looked pressable and did nothing.
 * A shown field's eye waits for the hover with its other actions; a hidden
 * field's eye-off rests (`restingActions`) and its label is drawn `inactive`,
 * so what is hidden reads at a glance. A hidden field stays where it is, so
 * showing it again puts it back in the same place — the list's order is the
 * body's, hidden fields included. The hidden state is also spelled out to
 * screen readers in the label.
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
  const {
    fields,
    activeState,
    activeViewId,
    viewModel,
    placement: spec,
    activeSlots,
  } = useDataViewControls();

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
  // Where the active view draws each field — the bands, when it places fields
  // by slot. Read unconditionally (a hook), over no slots for a view without.
  const placed = usePlacement(
    fields,
    activeState.properties,
    spec,
    activeSlots ?? NO_SLOTS,
  );

  if (fields.length <= 1) return null;

  return (
    <ControlPanel.Section label="Properties">
      {activeSlots === undefined ? (
        <FieldSections fields={controller.items.map((i) => i.field)}>
          {(sectionFields) => {
            const ids = new Set(sectionFields.map((f) => f.id));
            return (
              <PropertyRows
                controller={controller}
                items={controller.items.filter((i) => ids.has(i.field.id))}
                slots={null}
              />
            );
          }}
        </FieldSections>
      ) : (
        SLOTS.filter((slot) => slot === "hidden" || activeSlots[slot]).map(
          (slot) => {
            const items = bandItems(controller.items, placed, slot);
            if (items.length === 0) return null;
            return (
              <Fragment key={slot}>
                <ControlPanel.Subhead>{SLOT_LABELS[slot]}</ControlPanel.Subhead>
                <PropertyRows
                  controller={controller}
                  items={items}
                  slots={activeSlots}
                />
              </Fragment>
            );
          },
        )
      )}
      {controller.slotsCustomized ? (
        <ControlPanel.Row
          icon={<Icon icon={resetIcon} />}
          muted
          onSelect={controller.resetSlots}
        >
          Reset to the view&apos;s layout
        </ControlPanel.Row>
      ) : null}
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

/** One slot band's rows, in the order the view draws them (a hidden field in
 *  the Hidden band, whatever slot it would take). */
function bandItems<TRow>(
  items: readonly PropertyItem<TRow>[],
  placed: Placement<TRow>,
  slot: Slot,
): PropertyItem<TRow>[] {
  if (slot === "hidden") {
    const drawn = new Set(
      SLOTS.filter((s) => s !== "hidden").flatMap((s) =>
        placed.slots[s].map((f) => f.id),
      ),
    );
    return items.filter((i) => !i.visible || !drawn.has(i.field.id));
  }
  const byId = new Map(items.map((i) => [i.field.id, i]));
  return placed.slots[slot]
    .map((f) => byId.get(f.id))
    .filter((i): i is PropertyItem<TRow> => i !== undefined && i.visible);
}

/**
 * One band's sortable rows. The drop index is read off the FULL list:
 * `controller.move` reorders the one flat order the body reads (each slot
 * draws its fields in that order), and a drop inside a band always lands
 * inside it (each band is its own `DndContext`).
 */
function PropertyRows({
  controller,
  items,
  slots,
}: {
  controller: PropertiesController<unknown>;
  items: PropertyItem<unknown>[];
  /** The view's slots, when it places fields by slot (each row then offers
   *  "Show in…"); `null` otherwise. */
  slots: ViewSlots | null;
}): ReactNode {
  return (
    <SortableList
      items={items.map((i) => i.field.id)}
      orientation="vertical"
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
              inactive={!item.visible}
              onSelect={() => controller.toggle(item.field.id)}
              // The eye keeps the trailing edge either way: a shown field's
              // waits for the hover after "Show in…", a hidden field's rests.
              actions={
                <>
                  {slots === null ? null : (
                    <MoveToSlotButton field={item.field} />
                  )}
                  {item.visible ? (
                    <VisibilityButton
                      item={item}
                      onToggle={controller.toggle}
                    />
                  ) : null}
                </>
              }
              restingActions={
                item.visible ? undefined : (
                  <VisibilityButton item={item} onToggle={controller.toggle} />
                )
              }
            >
              {item.field.label}
              {!item.visible && <span className="sr-only"> (hidden)</span>}
            </ControlPanel.Row>
          )}
        </SortableItem>
      ))}
    </SortableList>
  );
}

/** The row's eye: shows or hides its field, saying which it is. */
function VisibilityButton({
  item,
  onToggle,
}: {
  item: PropertyItem<unknown>;
  onToggle: (id: string) => void;
}): ReactNode {
  return (
    <IconButton
      icon={item.visible ? visibilityIcon : hiddenIcon}
      label={`${item.visible ? "Hide" : "Show"} ${item.field.label}`}
      onClick={() => onToggle(item.field.id)}
    />
  );
}

/** The row's "Show in…" button: pushes the slot picker for its field. */
function MoveToSlotButton({ field }: { field: FieldDef<unknown> }): ReactNode {
  const { push } = usePanelStack();
  return (
    <IconButton
      icon={moveIcon}
      label={`Show ${field.label} in…`}
      onClick={() =>
        push({
          key: `properties-slot:${field.id}`,
          title: `Show ${field.label} in`,
          render: () => <SlotPicker fieldId={field.id} />,
        })
      }
    />
  );
}

/**
 * The pushed slot picker. It reads the controls itself: a stack entry's
 * `render` closure is captured at push time, so anything handed in would be
 * from the click, not from now.
 */
function SlotPicker({ fieldId }: { fieldId: string }): ReactNode {
  const { fields, activeState, activeViewId, viewModel, activeSlots } =
    useDataViewControls();
  const { pop } = usePanelStack();
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
  const item = controller.items.find((i) => i.field.id === fieldId);
  if (!item || activeSlots === undefined) return null;
  const pick = (slot: Slot | null) => {
    controller.moveToSlot(fieldId, slot);
    pop();
  };
  return (
    <ControlPanel.Section>
      <ControlPanel.Row
        select="radio"
        checked={item.slot === undefined}
        onSelect={() => pick(null)}
      >
        Where the view puts it
      </ControlPanel.Row>
      {SLOTS.filter((slot) => slot !== "hidden" && activeSlots[slot]).map(
        (slot) => (
          <ControlPanel.Row
            key={slot}
            select="radio"
            checked={item.slot === slot}
            onSelect={() => pick(slot)}
          >
            {SLOT_LABELS[slot]}
          </ControlPanel.Row>
        ),
      )}
    </ControlPanel.Section>
  );
}
