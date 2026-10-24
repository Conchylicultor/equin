import { useMemo } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  isRoleTag,
  placeTagTree,
  tagPlaceCounts,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { TagPickerPopover } from "@plugins/tag-tree/plugins/picker/web";

const addIcon = symbol("add");

/**
 * "+ Tag" on the place card: the shared tag picker (`tag-tree/picker`) over the
 * Places tree, picking ONE tag to add — Been / Want to go left out (the card
 * has its own toggles for them), and so are the tags the place already has.
 * Everything else the picker does (search, create a typed path, rename,
 * recolour, nest, reorder, delete) edits the tree itself.
 */
export function TagPicker({
  place,
  places,
  tags,
  onPick,
}: {
  place: Place;
  /** Every saved place: each tag's rolled-up count. */
  places: readonly Place[];
  /** The whole tag tree. */
  tags: readonly PlaceTag[];
  onPick: (tagId: string) => void;
}) {
  const counts = useMemo(() => tagPlaceCounts(places, tags), [places, tags]);
  return (
    <TagPickerPopover
      tree={placeTagTree}
      selected={[]}
      exclude={(t) => isRoleTag(t.id, tags) || place.tags.includes(t.id)}
      counts={counts}
      onPick={(tagId) => {
        // No "No tag" row is offered (`offerNone` is off): a pick is a tag.
        if (tagId !== null) onPick(tagId);
      }}
      trigger={
        <Button variant="dashed">
          <Icon icon={addIcon} />
          Tag
        </Button>
      }
    />
  );
}
