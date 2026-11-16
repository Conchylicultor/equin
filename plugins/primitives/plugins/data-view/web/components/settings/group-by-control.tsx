import { Fragment, type ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { useGroupByController } from "../../internal/use-group-by-controller";
import { FieldSections } from "../../internal/field-sections";
import {
  useDataViewControls,
  type DataViewControlsContextValue,
} from "../controls/controls-context";

/**
 * What the active view is grouped by, in words — the promoted Group by
 * trigger's tooltip ("Group by: Plugin"); `null` while ungrouped. Pure: a
 * closed trigger mounts no panel.
 */
export function describeGroupBy(
  ctx: DataViewControlsContextValue,
): string | null {
  const rule = ctx.activeState.groupBy;
  if (rule == null) return null;
  return ctx.fields.find((f) => f.id === rule.fieldId)?.label ?? rule.fieldId;
}

/**
 * Group-by setting (the first `view`-scope settings contribution): a field
 * picker writing `viewModel.setGroupBy`, reading groupable fields + the active
 * groupBy from `DataViewControlsContext`. Renders nothing when the active view
 * opts out of group-by (`supportsGroupBy: false`) or the schema has no
 * groupable field — so the panel stays empty-clean.
 *
 * Picking a field reveals a SECOND band when that field's type offers more than
 * one way to bucket ("Group dates by": Smart / Day / Week / Month / Year). Two
 * bands rather than a `usePanelStack` push (the precedent is
 * `add-sort-affordance.tsx`): the choice is small and closed, and seeing the
 * granularity next to the field is the point. The band's own label comes from
 * the field type's contribution — this file names no field type and knows no
 * granularity.
 *
 * Picking one field of several is single-select, so the rows say so in the one
 * language the vocabulary has for it: `select="radio"`, which paints a checkmark
 * and NO background fill. The old row drew its own leading
 * `<MdCheck className={selected ? undefined : "invisible"}/>` beside a
 * `selected` full-row highlight — a hand-made rail plus a second meaning for
 * "filled row", which already means hover.
 */
export function GroupByControl(): ReactNode {
  const {
    fields,
    activeState,
    activeViewId,
    viewModel,
    activeSupportsGroupBy,
    offersGrouping,
  } = useDataViewControls();

  const controller = useGroupByController(
    fields,
    activeState.groupBy ?? null,
    (rule) => viewModel.setGroupBy(activeViewId, rule),
    offersGrouping,
  );

  if (!activeSupportsGroupBy || controller.groupableFields.length === 0) {
    return null;
  }

  // The field row names only the field — `setField` resolves the granularity
  // (keeping the current one when the new type still offers it).
  const groupings = controller.groupings?.groupings ?? [];
  const activeFieldId = controller.groupBy?.fieldId ?? null;

  return (
    <Fragment>
      <ControlPanel.Section label="Group by">
        {/* "None" is one of the options, not a reset button beside them:
            ungrouped is a grouping choice, so it sits in the same radio set as
            the fields — above every band, because it belongs to none of them. */}
        <ControlPanel.Row
          select="radio"
          checked={activeFieldId === null}
          onSelect={() => controller.setField(null)}
        >
          None
        </ControlPanel.Row>
        <FieldSections fields={controller.groupableFields}>
          {(sectionFields) =>
            sectionFields.map((field) => (
              <ControlPanel.Row
                key={field.id}
                select="radio"
                checked={activeFieldId === field.id}
                onSelect={() => controller.setField(field.id)}
              >
                {field.label}
              </ControlPanel.Row>
            ))
          }
        </FieldSections>
      </ControlPanel.Section>
      {/* One choice is not a choice — a type declaring a single grouping (or
          none, falling back to the identity one) shows no band at all. */}
      {controller.groupings && groupings.length > 1 ? (
        <ControlPanel.Section label={controller.groupings.label}>
          {groupings.map((grouping) => (
            <ControlPanel.Row
              key={grouping.id}
              select="radio"
              checked={controller.groupingId === grouping.id}
              onSelect={() => controller.setGrouping(grouping.id)}
            >
              {grouping.label}
            </ControlPanel.Row>
          ))}
        </ControlPanel.Section>
      ) : null}
    </Fragment>
  );
}
