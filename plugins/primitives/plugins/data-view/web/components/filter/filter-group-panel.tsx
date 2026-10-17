import type { ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import type { FilterConjunction, FilterGroup } from "../../../core";
import { countRules, findGroup } from "../../internal/filter-tree-ops";
import { useFilterEditor } from "../../internal/use-filter-editor";
import { AddFilterRow } from "./add-filter-affordance";
import { ConjunctionCell } from "./conjunction-cell";
import { useFilterPanelStack } from "./filter-scope";
import { FilterRuleRow } from "./filter-rule-row";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const accountTreeIcon = symbol("account-tree");

/**
 * One group's children, as a section: the rule list, then this group's own
 * `Add filter` row.
 *
 * It takes a group ID rather than the group, and looks it up in the LIVE tree,
 * because it is also what a nested group pushes onto the panel stack — and a
 * stack entry's `render` closure is captured when the row is clicked, so a node
 * passed in would be the one from the moment the group was opened, and every edit
 * made inside it would be computed against that. The recursion mirrors the data:
 * one component per group, at any depth.
 *
 * Renders nothing when the id no longer resolves — deleting a group from inside
 * it is a legal thing to do, and the stack pops back on its own.
 */
export function FilterGroupPanel({ groupId }: { groupId: string }): ReactNode {
  const editor = useFilterEditor();
  const group = findGroup(editor.root, groupId);
  if (!group) return null;

  const setConjunction = (c: FilterConjunction) =>
    editor.setConjunction(group.id, c);

  return (
    <ControlPanel.Section needs="builder">
      {group.children.length === 0 ? (
        <ControlPanel.Empty>No filters yet</ControlPanel.Empty>
      ) : (
        <ControlPanel.RuleList>
          {group.children.map((child, index) =>
            child.kind === "rule" ? (
              <FilterRuleRow
                key={child.id}
                rule={child}
                index={index}
                groupConjunction={group.conjunction}
                onSetConjunction={setConjunction}
              />
            ) : (
              <NestedGroupRow
                key={child.id}
                group={child}
                index={index}
                parentConjunction={group.conjunction}
                onSetConjunction={setConjunction}
              />
            ),
          )}
        </ControlPanel.RuleList>
      )}
      <AddFilterRow groupId={group.id} />
    </ControlPanel.Section>
  );
}

/**
 * A child group, collapsed to ONE row that says what is in it — `Group · 3
 * conditions` — and opens it as a page.
 *
 * This is the one place the vocabulary changes what the user sees rather than
 * how it is drawn. A nested group used to render inline as a sunken box holding
 * its own indented editor, so each level of nesting ate horizontal room and a
 * deep group grew the popover past the edge of the pane. A pushed page is the
 * same box, the same width and the same rails at every depth.
 *
 * The `operator` slot is omitted, so the field cell spans it: a group has no
 * operator, and a hole mid-row would break the rail it shares with the rules
 * above it.
 */
function NestedGroupRow(props: {
  group: FilterGroup;
  index: number;
  parentConjunction: FilterConjunction;
  onSetConjunction: (conjunction: FilterConjunction) => void;
}): ReactNode {
  const { group } = props;
  const editor = useFilterEditor();
  const { push } = useFilterPanelStack();
  const count = countRules(group);

  return (
    <ControlPanel.RuleRow
      prefix={
        <ConjunctionCell
          index={props.index}
          conjunction={props.parentConjunction}
          onChange={props.onSetConjunction}
        />
      }
      field={
        <ControlPanel.Field
          icon={<Icon icon={accountTreeIcon} />}
          aria-label="Open filter group"
          label={`Group · ${count} ${count === 1 ? "condition" : "conditions"}`}
          onClick={() =>
            push({
              key: group.id,
              title: "Filter group",
              render: () => <FilterGroupPanel groupId={group.id} />,
            })
          }
        />
      }
      onRemove={() => editor.deleteNode(group.id)}
      removeLabel="Remove group"
    />
  );
}
