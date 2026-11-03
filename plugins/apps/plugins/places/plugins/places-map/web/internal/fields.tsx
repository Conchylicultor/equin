import { useMemo } from "react";
import {
  FieldPresentation,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import {
  fieldOverrides,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  mapResource,
  ResourceView,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  isRoleTag,
  placeFlags,
  placeName,
  places as placesCollection,
  placesEntityRef,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { usePlaceTags } from "@plugins/apps/plugins/places/plugins/places-core/web";
import { tagFieldOptions } from "@plugins/tag-tree/plugins/engine/core";
import { PlaceStatusBadges } from "../components/place-glyph";
import { TagChip } from "../components/tag-chip";

/**
 * The tags field's options: the LIVE tag tree, in tree order (`tagFieldOptions`)
 * — each names its parent, so the nested operators (`has-nested` /
 * `lacks-nested`, the sidebar's rules) reach a tag's descendants and the
 * filter builder lists the tree. Loading until it is known — never an empty
 * vocabulary, or the sidebar's rules would match nothing.
 */
function useTagFieldOptions(): LiveFieldOptionsRead {
  const tags = usePlaceTags();
  return useMemo(() => mapResource(tags, tagFieldOptions), [tags]);
}

/** A place's tags as chips, the tree read where the cell is drawn. */
function PlaceTagsCell({ tagIds }: { tagIds: readonly string[] }) {
  const tags = usePlaceTags();
  // The same tinted chips wherever the field is drawn — the side panel's
  // list, its gallery card, a table — so a tag reads the same everywhere.
  return (
    <ResourceView resource={tags} fallback={<Loading variant="block" />}>
      {(all) => <PlaceTagChipLine tagIds={tagIds} tags={all} />}
    </ResourceView>
  );
}

/** A place's tags as chips on ONE clipped line (never wrapping into a row's
 *  next line), Been / Want to go left out (each has its own pill). */
function PlaceTagChipLine({
  tagIds,
  tags,
}: {
  tagIds: readonly string[];
  tags: readonly PlaceTag[];
}) {
  const byId = new Map<string, PlaceTag>(tags.map((t) => [t.id, t]));
  return (
    <Clip className="whitespace-nowrap">
      <Stack direction="row" gap="2xs">
        {tagIds
          .filter((id) => !isRoleTag(id, tags))
          .map((id) => byId.get(id))
          .filter((t): t is PlaceTag => t !== undefined)
          .map((t) => (
            <TagChip key={t.id} tag={t} tags={tags} />
          ))}
      </Stack>
    </Clip>
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

/** A place's Google primary type in words, its first letter capitalised
 *  (`french_restaurant` → "French restaurant"); null when it has none. */
function placeKindLabel(p: Place): string | null {
  if (p.primaryType === null) return null;
  const words = p.primaryType.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
      // What the place is, in words: Google's primary type ("French
      // restaurant"); nothing for a custom place or one Google gives no type.
      id: "kind",
      label: "Type",
      type: "text",
      value: (p) => placeKindLabel(p),
      sortable: true,
      filterable: true,
      groupable: true,
      visible: false,
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
      // Want to go and Been as one status, drawn as their pills — a row's
      // one state column. Display only: `want` / `been` are what filter,
      // sort and group.
      id: "status",
      label: "Status",
      type: "text",
      value: (p) => {
        const { want, been } = placeFlags(p, tags);
        return [want && "Want to go", been && "Been"]
          .filter(Boolean)
          .join(", ");
      },
      cell: (p) => <PlaceStatusBadges {...placeFlags(p, tags)} />,
      sortable: false,
      filterable: false,
      groupable: false,
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
  ];
}

/**
 * The overrides every list of places applies (the map's presets and the side
 * panel alike): the location is the map's axis, not an ordering — the one
 * derived field the lists do not sort by.
 */
export const PLACE_OVERRIDES = fieldOverrides(placesCollection, {
  location: { sortable: false },
});
