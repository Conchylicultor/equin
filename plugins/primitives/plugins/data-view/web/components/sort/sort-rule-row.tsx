import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { SortableItem } from "@plugins/primitives/plugins/sortable-list/web";
import type { FieldDef, SortRule } from "../../../core";
import { useResolveDirectionLabels } from "../../internal/use-direction-labels";
import { dragHandleProps } from "../../internal/drag-handle-props";
import { FieldPicker } from "../filter/field-picker";
import { DirectionPicker } from "./direction-picker";
import { symbol } from "@plugins/ui/plugins/icons/core";

const keepIcon = symbol("keep");

/**
 * One sort level, read as a sentence: `Sort by [field] [direction]`, then
 * `then by …` for each level under it. It is a `ControlPanel.RuleRow` on the
 * builder's six-track grid, so its columns line up down the list AND with the
 * filter builder's — where it used to be a `justify-between` flex row whose
 * pickers hugged their own content.
 *
 * There is no operator in a sort, so the `operator` slot is OMITTED rather than
 * filled with a spacer: the row then reports `data-span="field"` and the field
 * cell takes the operator's track, which keeps the rails identical to the filter
 * builder's without leaving a hole mid-row.
 *
 * The whole row is a `SortableItem` keyed by `fieldId` — priority = list order,
 * reordered by dragging the handle in the row's gutter track.
 *
 * The trailing pin toggles the rule's `pinned` flag (see `pinned-sort.ts`): a
 * pinned rule sorts before every other one and survives header clicks, preset
 * apply and Clear sort. Pressed, it shows at rest — the state is information;
 * unpressed, it reveals on hover like any secondary row action.
 */
export function SortRuleRow<TRow>(props: {
  rule: SortRule;
  /** Position in the list — the first level reads "Sort by", the rest "then by". */
  index: number;
  fields: FieldDef<TRow>[];
  onChangeField: (nextFieldId: string) => void;
  onSetDirection: (direction: "asc" | "desc") => void;
  onTogglePinned: () => void;
  onRemove: () => void;
}): ReactNode {
  const { rule } = props;
  const resolveDirectionLabels = useResolveDirectionLabels();
  const activeField = props.fields.find((f) => f.id === rule.fieldId);
  const directionLabels = resolveDirectionLabels(activeField?.type);
  const pinned = rule.pinned === true;

  return (
    <SortableItem
      id={rule.fieldId}
      handle
      className={({ isDragging }) => cn(isDragging && "opacity-40")}
    >
      {(state) => (
        <ControlPanel.RuleRow
          handle
          handleProps={dragHandleProps(state)}
          prefix={props.index === 0 ? "Sort by" : "then by"}
          field={
            <FieldPicker
              fields={props.fields}
              value={rule.fieldId}
              onChange={props.onChangeField}
              label="Sort field"
              placeholder="Sort by…"
            />
          }
          value={
            <DirectionPicker
              value={rule.direction}
              labels={directionLabels}
              onChange={props.onSetDirection}
            />
          }
          actions={
            <IconButton
              icon={keepIcon}
              active={pinned}
              aria-pressed={pinned}
              label={
                pinned ? "Unpin sort" : "Pin sort — always sort by this first"
              }
              className={pinned ? "text-primary-text" : undefined}
              onClick={props.onTogglePinned}
            />
          }
          actionsAtRest={pinned}
          onRemove={props.onRemove}
          removeLabel="Remove sort"
        />
      )}
    </SortableItem>
  );
}
