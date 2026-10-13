import type {
  FieldDef,
  FieldOption,
} from "@plugins/primitives/plugins/data-view/web";
import {
  placeStatus,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { PlaceTagChips } from "../components/tag-chip";
import { TAGS_FIELD_ID } from "./sidebar-filter";

/** The derived status column: `done` when the place carries the done tag. */
const STATUS_OPTIONS: FieldOption[] = [
  { value: "todo", label: "Todo", variant: "muted" },
  { value: "done", label: "Done", variant: "success" },
];

/**
 * The tag tree as the tags field's options: each tag names its parent, so
 * the nested operators (`has-nested` / `lacks-nested`, the sidebar's rules)
 * reach a tag's descendants and the filter builder lists the tree.
 */
export function tagOptions(tags: readonly PlaceTag[]): FieldOption[] {
  return tags.map((t) => ({
    value: t.id,
    label: t.name,
    ...(t.parentId === null ? {} : { parent: t.parentId }),
  }));
}

/**
 * What the search box matches a place on — the DataView's `searchAccessor`,
 * and the sidebar's shown count, which must agree with it.
 */
export function placeSearchText(p: Place): string {
  return `${p.name} ${p.address} ${p.note}`;
}

/**
 * The Places DataView schema. `tags` filters on EVERY tag id the place
 * carries (status included, so the sidebar can include / exclude Todo and
 * Done), and draws the non-status ones as coloured chips; `status` is the
 * same fact as its own groupable column.
 */
export function placeFieldDefs(tags: readonly PlaceTag[]): FieldDef<Place>[] {
  return [
    {
      id: "name",
      label: "Name",
      type: "text",
      primary: true,
      value: (p) => p.name,
      sortable: true,
      filterable: true,
    },
    {
      id: "address",
      label: "Address",
      type: "text",
      value: (p) => p.address,
      sortable: true,
      filterable: true,
    },
    {
      id: TAGS_FIELD_ID,
      label: "Tags",
      type: "tags",
      values: (p) => p.tags,
      options: tagOptions(tags),
      cell: (p) => <PlaceTagChips tagIds={p.tags} tags={tags} />,
      filterable: true,
    },
    {
      id: "status",
      label: "Status",
      type: "enum",
      value: (p) => placeStatus(p, tags),
      options: STATUS_OPTIONS,
      sortable: true,
      filterable: true,
      groupable: true,
      width: "6rem",
    },
    {
      id: "location",
      label: "Location",
      type: "location",
      data: (p) => p.location,
      // The map's axis, not a column worth reading in a list.
      visible: false,
    },
    {
      id: "note",
      label: "Note",
      type: "text",
      value: (p) => p.note,
      filterable: true,
      visible: false,
    },
    {
      id: "createdAt",
      label: "Saved",
      type: "date",
      value: (p) => p.createdAt,
      sortable: true,
      filterable: true,
      visible: false,
    },
  ];
}
