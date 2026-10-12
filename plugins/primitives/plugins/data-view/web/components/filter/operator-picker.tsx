import { Fragment, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSection,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import type { FilterOperator } from "../../../core";

/** One rendered section: a `group` label (empty string = the default,
 *  unlabeled section) plus its visible operators, in first-seen order. */
interface OperatorGroup {
  label: string;
  operators: FilterOperator[];
}

/** Bucket the visible operators by their `group`, preserving the first-seen
 *  order of both groups and operators. Ungrouped operators collect under the
 *  leading unlabeled (`""`) section, so field types without groups render as a
 *  single flat list exactly as before. */
function groupOperators(operators: FilterOperator[]): OperatorGroup[] {
  const groups: OperatorGroup[] = [];
  const byLabel = new Map<string, OperatorGroup>();
  for (const op of operators) {
    if (op.hidden) continue;
    const label = op.group ?? "";
    let group = byLabel.get(label);
    if (!group) {
      group = { label, operators: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.operators.push(op);
  }
  return groups;
}

/**
 * Dropdown of the current field type's operators. Selecting an operator reports
 * the id to the host, which clears the rule value when `hasValue` toggles (esp.
 * moving to a value-less operator like "Is empty").
 *
 * The trigger label resolves against the FULL operator list (including hidden
 * operators) so a saved filter on a hidden operator still shows its label; the
 * menu offers only non-hidden operators, grouped by their `group` section.
 */
export function OperatorPicker(props: {
  operators: FilterOperator[];
  value: string;
  onChange: (operatorId: string) => void;
}): ReactNode {
  const current = props.operators.find((o) => o.id === props.value);
  const groups = groupOperators(props.operators);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ControlPanel.Field
            aria-label="Filter operator"
            label={current?.label ?? null}
            placeholder="—"
          />
        }
      />
      <DropdownMenuContent align="start">
        {groups.map((group, index) => {
          const items = group.operators.map((op) => (
            <DropdownMenuItem key={op.id} onClick={() => props.onChange(op.id)}>
              {op.label}
            </DropdownMenuItem>
          ));
          return (
            <Fragment key={group.label || "__default"}>
              {index > 0 && <DropdownMenuSeparator />}
              {group.label ? (
                <DropdownMenuSection label={group.label}>
                  {items}
                </DropdownMenuSection>
              ) : (
                // The default, unlabeled section renders its items flat — no
                // group/label wrapper.
                items
              )}
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
