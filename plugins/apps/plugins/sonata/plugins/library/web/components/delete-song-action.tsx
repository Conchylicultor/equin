import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { deleteSong } from "../../core";
import type { Song } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";

const deleteIcon = symbol("delete");

/**
 * Per-row Delete action for the library. Contributed once into
 * `Library.SongActions`, so it appears in the gallery card's hover cluster AND
 * the table row's trailing one — the table's first delete. Left at the default
 * `"revealed"` zone: a destructive action does not belong painted at rest.
 * The click never activates the row (stopPropagation), so it can't open the
 * player on its way out. Deleting the song loaded in the player stops it: the
 * now-playing bar disappears with its row, and nothing else could pause it.
 */
export function DeleteSongAction({ row }: ItemActionProps<Song>) {
  const { mutate: deleteSongMutation } = useEndpointMutation(deleteSong);
  const { currentSongId } = useSonataApp();
  const { stop } = useSession();
  return (
    <IconButton
      icon={deleteIcon}
      label="Delete"
      onClick={(e) => {
        e.stopPropagation();
        if (row.id === currentSongId) stop();
        deleteSongMutation({ params: { id: row.id } });
      }}
    />
  );
}
