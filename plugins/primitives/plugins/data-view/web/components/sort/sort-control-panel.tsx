import type { ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { SortableList } from "@plugins/primitives/plugins/sortable-list/web";
import { useDataViewControls } from "../controls/controls-context";
import { FieldSearchList } from "../filter/field-search-list";
import { AddSortRow } from "./add-sort-affordance";
import { SortPresetSection, SortSavePresetPanel } from "./presets";
import { SortRuleRow } from "./sort-rule-row";
import { splitPinned } from "../../internal/pinned-sort";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const bookmarkAddIcon = symbol("bookmark-add");
const closeIcon = symbol("close");

/**
 * The sort control's panel body. Prop-less by contract — it reads the live
 * controller and `manualOrderOverridden` off `useDataViewControls()`.
 *
 * With no rules yet it IS the search-first field list ("Sort by…" typeahead over
 * the sortable fields): picking a field adds the first level in one click. Once
 * populated it hosts the reorderable rule list (drag = change priority), an
 * `Add sort` row over the fields not yet used, and a footer of Save-as-preset /
 * Clear-sort ROWS — where the footer used to be two ghost buttons pushed to
 * opposite corners, one of which opened a popover inside the popover.
 *
 * A field can be sorted at most once, so each row's picker offers only the fields
 * not used by OTHER rows.
 */
export function SortControlPanel(): ReactNode {
  const { sort, manualOrderOverridden } = useDataViewControls();

  const usedIds = new Set(sort.rules.map((r) => r.fieldId));
  const availableToAdd = sort.sortableFields.filter((f) => !usedIds.has(f.id));
  const hasRules = sort.rules.length > 0;
  const { pinned, user } = splitPinned(sort.rules);

  return (
    <>
      <SortPresetSection />

      {hasRules ? (
        <ControlPanel.Section>
          <ControlPanel.RuleList>
            {/* Pinned rules are a prefix (`pinned-sort.ts`), so each segment is
                its own sortable list: a drag reorders within its segment and
                never carries a rule across the boundary — pinning is the
                trailing toggle's job. */}
            {[pinned, user].map((segment, segmentIndex) =>
              segment.length ? (
                <SortableList
                  key={segmentIndex === 0 ? "pinned" : "user"}
                  items={segment.map((r) => r.fieldId)}
                  orientation="vertical"
                  onMove={(activeId, overId) => {
                    const toIndex = sort.rules.findIndex(
                      (r) => r.fieldId === overId,
                    );
                    if (toIndex !== -1) sort.move(activeId, toIndex);
                  }}
                >
                  {segment.map((rule) => (
                    <SortRuleRow
                      key={rule.fieldId}
                      rule={rule}
                      index={sort.rules.indexOf(rule)}
                      fields={sort.sortableFields.filter(
                        (f) => !usedIds.has(f.id) || f.id === rule.fieldId,
                      )}
                      onChangeField={(next) =>
                        sort.setField(rule.fieldId, next)
                      }
                      onSetDirection={(dir) =>
                        sort.setDirection(rule.fieldId, dir)
                      }
                      onTogglePinned={() => sort.togglePinned(rule.fieldId)}
                      onRemove={() => sort.removeRule(rule.fieldId)}
                    />
                  ))}
                </SortableList>
              ) : null,
            )}
          </ControlPanel.RuleList>
          <AddSortRow />
        </ControlPanel.Section>
      ) : (
        <ControlPanel.Section>
          <ControlPanel.Empty>
            No sorts yet — pick a field to sort by.
          </ControlPanel.Empty>
          <FieldSearchList
            fields={availableToAdd}
            placeholder="Sort by…"
            onPick={sort.addRule}
          />
        </ControlPanel.Section>
      )}

      {/* A sort silently overriding a manual drag order is the last remaining
          cause of "drag stopped working" with no visible reason, and this panel
          is where the remedy (Clear sort) already lives. It gets its own section
          so the panel's own hairline sets it off. */}
      {manualOrderOverridden ? (
        <ControlPanel.Section>
          <ControlPanel.Empty>
            Manual drag order is overridden while a sort is set. Clear the sort
            to reorder.
          </ControlPanel.Empty>
        </ControlPanel.Section>
      ) : null}

      {hasRules ? (
        <ControlPanel.Footer>
          <ControlPanel.Row
            icon={<Icon icon={bookmarkAddIcon} />}
            push={{
              key: "save-sort-preset",
              title: "Save as preset",
              render: () => <SortSavePresetPanel />,
            }}
          >
            Save as preset
          </ControlPanel.Row>
          {/* Clearing leaves the panel OPEN, on the field picker it started from
              — the panel is a prop-less body the toolbar mounts, and in the
              compact fold there is no popover to close at all, so "clear and
              dismiss" is not one gesture it can express in both layouts. */}
          {/* Clear drops the USER rules only; with nothing but pinned rules
              left there is nothing for it to do, so it goes (unpin or remove
              a pinned rule from its own row). */}
          {user.length ? (
            <ControlPanel.Row
              icon={<Icon icon={closeIcon} />}
              tone="danger"
              onSelect={() => sort.clear()}
            >
              Clear sort
            </ControlPanel.Row>
          ) : null}
        </ControlPanel.Footer>
      ) : null}
    </>
  );
}
