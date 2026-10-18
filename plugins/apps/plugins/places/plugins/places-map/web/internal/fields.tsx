import { useMemo } from "react";
import {
  FieldPresentation,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import {
  mapResource,
  ResourceView,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  placeFlags,
  placeName,
  placesEntityRef,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { usePlaceTags } from "@plugins/apps/plugins/places/plugins/places-core/web";
import { PlaceTagChips } from "../components/tag-chip";

// A tag as the tags field's option: each names its parent, so the nested
// operators (`has-nested` / `lacks-nested`, the sidebar's rules) reach a tag's
// descendants and the filter builder lists the tree. Stable (module-level), so
// the mapped read changes only with the tag tree.
function tagOptions(tags: readonly PlaceTag[]): readonly LiveFieldOption[] {
  return tags.map((t) => ({
    value: t.id,
    label: t.name,
    ...(t.parentId === null ? {} : { parent: t.parentId }),
  }));
}

/**
 * The tags field's options: the LIVE tag tree. Loading until it is known —
 * never an empty vocabulary, or the sidebar's rules would match nothing.
 */
function useTagFieldOptions(): LiveFieldOptionsRead {
  const tags = usePlaceTags();
  return useMemo(() => mapResource(tags, tagOptions), [tags]);
}

/** A place's tags as chips, the tree read where the cell is drawn. */
function PlaceTagsCell({ tagIds }: { tagIds: readonly string[] }) {
  const tags = usePlaceTags();
  return (
    <ResourceView resource={tags} fallback={<Loading variant="block" />}>
      {(all) => <PlaceTagChips tagIds={tagIds} tags={all} />}
    </ResourceView>
  );
}

/**
 * How the stored place fields present in the Places list: the tags as the tag
 * tree's options and coloured chips (Been / Want to go left out — each has its
 * own column), and the dimensions a body leaves out by default — Google's
 * status, the map's location axis, the note and the saved date.
 */
export const placePresentation = FieldPresentation.Register({
  owner: placesEntityRef,
  fields: {
    tags: {
      useOptions: useTagFieldOptions,
      cell: (tagIds) => <PlaceTagsCell tagIds={tagIds} />,
    },
    businessStatus: { visible: false },
    location: { visible: false },
    note: { visible: false },
    createdAt: { visible: false },
  },
});

/**
 * What the search box matches a place on — the DataView's `searchAccessor`,
 * and the sidebar's shown count, which must agree with it. The user's title
 * AND Google's name: either finds the place.
 */
export function placeSearchText(p: Place): string {
  return `${placeName(p)} ${p.name} ${p.address} ${p.note}`;
}

/**
 * The fields the Places list computes itself; every stored one it derives from
 * `places` (address, tags, Google's status, location, note, saved date).
 * `name` is the name the app shows (`placeName`: the user's title, else
 * Google's or a custom place's). `want` and `been` are the tags' Been / Want
 * to go facts as their own groupable yes / no columns, and `googleLost`
 * whether Google no longer finds the place's id (its details frozen as last
 * fetched). The tag tree decides the flags, so the list is built from it.
 */
export function placeExtraFields(tags: readonly PlaceTag[]): FieldDef<Place>[] {
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
      id: "googleLost",
      label: "Google link lost",
      type: "bool",
      value: (p) => p.googleLostAt !== null,
      sortable: true,
      filterable: true,
      groupable: true,
      visible: false,
    },
  ];
}
