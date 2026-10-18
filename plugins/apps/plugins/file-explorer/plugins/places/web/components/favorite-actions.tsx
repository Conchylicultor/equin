import type { ReactNode } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useConfigResult } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { EntryRow } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { placesConfig } from "../../shared/config";
import { PINNED_SOURCE, useFavorites } from "../internal/favorites";
import type { PlaceRow } from "../internal/place-row";

const starIcon = symbol("star");
const closeIcon = symbol("close");

/**
 * Add to Favorites, on a browser row (its ⋯ menu): pins the entry to the
 * Places sidebar's Favorites — or, once pinned, Remove from Favorites. Waits
 * for the pinned list, so it never offers the wrong one.
 */
export function AddToFavoritesAction({
  row,
}: ItemActionProps<EntryRow>): ReactNode {
  const config = useConfigResult(placesConfig);
  const { pin, unpin } = useFavorites();
  // Not known yet (or unreadable): neither label can be claimed.
  const pinned = foldResource(config, {
    loading: () => null,
    error: () => null,
    ready: (data) => data.pinned.some((p) => p.path === row.path),
  });
  return (
    <IconButton
      icon={starIcon}
      label={pinned === true ? "Remove from Favorites" : "Add to Favorites"}
      disabled={pinned === null}
      onClick={() =>
        pinned === true
          ? unpin(row.path)
          : pin([{ path: row.path, kind: row.kind === "dir" ? "dir" : "file" }])
      }
    />
  );
}

/** Remove from Favorites, on a pinned place's row. */
export function RemoveFavoriteAction({
  row,
}: ItemActionProps<PlaceRow>): ReactNode {
  const { unpin } = useFavorites();
  const { placeId } = row;
  if (row.source !== PINNED_SOURCE || placeId === null) return null;
  return (
    <IconButton
      icon={closeIcon}
      label="Remove from Favorites"
      onClick={() => unpin(placeId)}
    />
  );
}
