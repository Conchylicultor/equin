import type { ReactNode } from "react";
import {
  SearchInput,
  useTextFilter,
} from "@plugins/primitives/plugins/search/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { FieldDef } from "../../../core";
import { useResolveFieldIcon } from "../../internal/use-field-icon";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { FieldSections, fieldSearchText } from "../../internal/field-sections";

/**
 * Notion-style search-first field picker: a "Filter by…" typeahead over the
 * schema's filterable fields, each rendered as an icon + label
 * `ControlPanel.Row` — the shared menu row, so the list highlights, sizes and
 * reads like every other menu. Selecting a field reports its id to `onPick` in a
 * single click. It must be drawn inside a control panel (every host is one: the
 * filter / sort panels, and `FieldPicker`'s `ControlPanelPopover`). The panel
 * scrolls the list; there is no inner scroller, which would clip the rows'
 * full-width highlight. The shared building block
 * behind every "choose a field" surface in the filter builder — the empty state,
 * the `Add filter` affordance, and changing an existing rule's field — so they
 * all gain typeahead from one place.
 *
 * A schema several plugins contributed to is listed band by band under its
 * sections (`Common`, then each contributor's), and the typeahead matches the
 * band's name as well as the field's — so on the merged run surface "deploy"
 * finds the deploy arm's eight columns whatever they are called.
 */
export function FieldSearchList<TRow>(props: {
  fields: FieldDef<TRow>[];
  onPick: (fieldId: string) => void;
  /** Search input placeholder. Defaults to "Filter by…" (the filter-builder copy). */
  placeholder?: string;
  /** Optional advanced affordance rendered below the list (e.g. "Add filter group"). */
  footer?: ReactNode;
}): ReactNode {
  const resolveIcon = useResolveFieldIcon();
  const { query, setQuery, filtered } = useTextFilter({
    items: props.fields,
    accessor: fieldSearchText,
  });

  return (
    <Stack gap="xs">
      <SearchInput
        appearance="menu"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={props.placeholder ?? "Filter by…"}
        aria-label="Search fields"
      />
      {filtered.length === 0 ? (
        <Text as="div" variant="caption" tone="muted" className="py-xs">
          No fields
        </Text>
      ) : (
        // Sectioned over the FILTERED set, so a search that matches nothing
        // in a band drops that band's heading with it.
        <FieldSections fields={filtered}>
          {(fields) =>
            fields.map((field) => {
              const icon = resolveIcon(field.type ?? "text");
              return (
                <ControlPanel.Row
                  key={field.id}
                  icon={icon ? <Icon icon={icon} /> : undefined}
                  onSelect={() => props.onPick(field.id)}
                >
                  {field.label}
                </ControlPanel.Row>
              );
            })
          }
        </FieldSections>
      )}
      {props.footer}
    </Stack>
  );
}
