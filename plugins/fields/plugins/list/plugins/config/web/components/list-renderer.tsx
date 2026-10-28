import { arrayMove } from "@plugins/primitives/plugins/sortable-list/web";
import { defineFieldShape } from "@plugins/config_v2/plugins/fields/web";
import { fieldDefaults, type FieldsRecord } from "@plugins/fields/core";
import {
  listFieldType,
  type ListItem,
} from "@plugins/fields/plugins/list/core";
import type { ListFieldDef } from "../../core";

/**
 * A list of records: one `list` of `group` items. The sortable shell, the drag
 * handle, the remove button, the per-item card and the recursion into
 * `FieldRenderer` all left this file — an item is ITSELF a shape, so the panel
 * knows how to draw one.
 */
const ListRenderer = defineFieldShape({
  type: listFieldType,
  useShape: ({ field, value, onChange }) => {
    const { itemFields } = field as unknown as ListFieldDef;
    return {
      kind: "list",
      addLabel: "Add item",
      items: value.map((item) => ({
        id: item.id,
        shape: {
          kind: "group",
          fields: itemFields,
          values: item as Record<string, unknown>,
          onChangeField: (key, next) =>
            onChange(
              value.map((row) =>
                row.id === item.id
                  ? ({ ...row, [key]: next } as ListItem<FieldsRecord>)
                  : row,
              ),
            ),
        },
      })),
      // Appended at the end — array position is the order, so a reorder is a
      // plain array splice with no fractional rank to recompute.
      onAdd: () =>
        onChange([
          ...value,
          {
            id: crypto.randomUUID(),
            ...fieldDefaults(itemFields, "listField"),
          } as ListItem<FieldsRecord>,
        ]),
      onRemove: (id) => onChange(value.filter((item) => item.id !== id)),
      onMove: (activeId, overId) => {
        const from = value.findIndex((i) => i.id === activeId);
        const to = value.findIndex((i) => i.id === overId);
        if (from === -1 || to === -1) return;
        onChange(arrayMove(value, from, to));
      },
    };
  },
});

export { ListRenderer };
