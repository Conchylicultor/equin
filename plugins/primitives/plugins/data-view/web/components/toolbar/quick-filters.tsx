import { Fragment, type ReactNode } from "react";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type {
  OperandQuickFilter,
  QuickFilter,
  SegmentedQuickFilter,
} from "../../../core";
import { useDataViewControls } from "../controls/controls-context";
import { PillDivider } from "./pills-toolbar";
import {
  activeQuickOperand,
  activeQuickOption,
  applyQuickOperand,
  applyQuickOption,
} from "../../internal/quick-filter";

/**
 * The surface's quick filters (`DataViewProps.quickFilters`), over the active
 * view's filter — what each shows read off it, an edit written through the
 * same `setFilter` the Filter panel uses. A segmented one selects none when
 * the filter holds a rule no option names; an operand one draws its
 * operator's own `ValueInput`. Reads the controls context, so it renders
 * wherever the toolbar's controls do (the band, the compact fold's panel, a
 * hosted frame's options, a section's `⋯`).
 *
 * `layout: "row"` (a band's pill) parts the groups with the pill divider, so
 * two controls never read as one strip of chips; `"column"` (a panel, each
 * group on its own line) needs none.
 */
export function QuickFilters({
  quickFilters,
  layout,
}: {
  quickFilters: readonly QuickFilter[];
  layout: "row" | "column";
}): ReactNode {
  const { fields } = useDataViewControls();
  return quickFilters.map((qf, i) => {
    // A quick filter on a field the schema lacks would write rules nothing
    // runs: an authoring mistake, said where it is made.
    if (!fields.some((f) => f.id === qf.fieldId))
      throw new Error(
        `DataView quick filter "${qf.id}" names field "${qf.fieldId}", which the surface's schema does not declare.`,
      );
    return (
      <Fragment key={qf.id}>
        {layout === "row" && i > 0 ? <PillDivider /> : null}
        {qf.kind === "segmented" ? (
          <SegmentedQuickFilterControl qf={qf} />
        ) : (
          <OperandQuickFilterControl qf={qf} />
        )}
      </Fragment>
    );
  });
}

function SegmentedQuickFilterControl({
  qf,
}: {
  qf: SegmentedQuickFilter;
}): ReactNode {
  const { filter } = useDataViewControls();
  return (
    <SegmentedControl
      label={qf.label}
      options={qf.options}
      value={activeQuickOption(filter.filter, qf)}
      onChange={(id) => {
        const option = qf.options.find((o) => o.id === id);
        if (option === undefined)
          throw new Error(`Quick filter "${qf.id}" has no option "${id}".`);
        filter.setFilter(applyQuickOption(filter.filter, qf, option));
      }}
    />
  );
}

/**
 * The label, then the operator's own operand editor bound to the field's one
 * rule. A filter holding something else on the field (a hand-edited rule)
 * shows as such — never as "no filter" — and an edit here replaces it.
 */
function OperandQuickFilterControl({
  qf,
}: {
  qf: OperandQuickFilter;
}): ReactNode {
  const { filter } = useDataViewControls();
  const field = filter.filterableFields.find((f) => f.id === qf.fieldId);
  if (field === undefined)
    throw new Error(
      `DataView quick filter "${qf.id}": field "${qf.fieldId}" is not filterable.`,
    );
  const operator = filter
    .resolveOperatorSet(field.type ?? "text")
    ?.operators.find((o) => o.id === qf.operatorId);
  const ValueInput = operator?.hasValue ? operator.ValueInput : undefined;
  if (ValueInput === undefined)
    throw new Error(
      `DataView quick filter "${qf.id}": "${qf.operatorId}" is not an operator with a value of field "${qf.fieldId}".`,
    );
  const held = activeQuickOperand(filter.filter, qf);
  return (
    <Line className="gap-xs">
      <Text as="span" variant="caption" tone="muted">
        {qf.label}
      </Text>
      <span className="w-48">
        <ValueInput
          field={field}
          value={held.kind === "value" ? held.value : undefined}
          placeholder={
            held.kind === "other" ? "Custom (see Filter)" : qf.placeholder
          }
          onChange={(value) =>
            filter.setFilter(applyQuickOperand(filter.filter, qf, value))
          }
        />
      </span>
    </Line>
  );
}
