import type {
  FieldDef,
  FieldOption,
} from "@plugins/primitives/plugins/data-view/web";
import {
  placeFlags,
  placeName,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import type { BusinessStatus } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { PlaceTagChips } from "../components/tag-chip";
import { TAGS_FIELD_ID } from "./sidebar-filter";

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

/** Google's business status, as the status field's options (null is "None"). */
const BUSINESS_STATUS_OPTIONS: FieldOption[] = [
  { value: "OPERATIONAL", label: "Open", variant: "success" },
  {
    value: "CLOSED_TEMPORARILY",
    label: "Temporarily closed",
    variant: "warning",
  },
  {
    value: "CLOSED_PERMANENTLY",
    label: "Permanently closed",
    variant: "destructive",
  },
] satisfies (FieldOption & { value: BusinessStatus })[];

/**
 * What the search box matches a place on — the DataView's `searchAccessor`,
 * and the sidebar's shown count, which must agree with it. The user's title
 * AND Google's name: either finds the place.
 */
export function placeSearchText(p: Place): string {
  return `${placeName(p)} ${p.name} ${p.address} ${p.note}`;
}

/**
 * The Places DataView schema. `name` is the name the app shows (`placeName`:
 * the user's title, else Google's or a custom place's). `tags` filters on
 * EVERY tag id the place carries (Been / Want to go included, so the sidebar
 * can include / exclude them), and draws the others as coloured chips; `want`
 * and `been` are the same two facts as their own groupable yes / no columns;
 * `businessStatus` is Google's word on whether the place is still open (none
 * for a custom place); `googleLost` whether Google no longer finds the place's
 * id (its details frozen as last fetched).
 */
export function placeFieldDefs(tags: readonly PlaceTag[]): FieldDef<Place>[] {
  return [
    {
      id: "name",
      label: "Name",
      type: "text",
      primary: true,
      value: (p) => placeName(p),
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
      id: "want",
      label: "Want to go",
      type: "bool",
      value: (p) => placeFlags(p, tags).want,
      sortable: true,
      filterable: true,
      groupable: true,
      width: "6rem",
    },
    {
      id: "been",
      label: "Been",
      type: "bool",
      value: (p) => placeFlags(p, tags).been,
      sortable: true,
      filterable: true,
      groupable: true,
      width: "5rem",
    },
    {
      id: "businessStatus",
      label: "Google status",
      type: "enum",
      value: (p) => p.businessStatus,
      options: BUSINESS_STATUS_OPTIONS,
      sortable: true,
      filterable: true,
      groupable: true,
      visible: false,
    },
    {
      id: "googleLost",
      label: "Google link lost",
      type: "bool",
      value: (p) => p.googleLostAt !== null,
      sortable: true,
      filterable: true,
      groupable: true,
      visible: false,
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
