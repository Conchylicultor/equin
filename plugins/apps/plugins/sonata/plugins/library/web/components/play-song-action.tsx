import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import type { Song } from "../../core";
import { useSonataPlayback } from "../use-playback";
import { symbol } from "@plugins/ui/plugins/icons/core";

const pauseIcon = symbol("pause");
const playArrowIcon = symbol("play-arrow");

/**
 * Is this song the one playing? The Play action's `useActive`: while it is,
 * the action rests (stays painted without hover) in every view — so the
 * playing card keeps its Pause button.
 */
export function useSongPlaying(song: Song): boolean {
  const { currentSongId } = useSonataApp();
  const { isPlaying } = useSession();
  return currentSongId === song.id && isPlaying;
}

/**
 * The library's primary per-song action: Play / Pause in the background (no
 * navigation) via the shared transport, Pause while the row's song is the one
 * playing. Drawn for its placement — `primary`, the round filled button over a
 * card's cover or a list thumbnail; `cluster`, an icon button among the row's
 * other actions (the table). The click never activates the row
 * (stopPropagation), so it won't open the full player.
 */
export function PlaySongAction({ row, placement }: ItemActionProps<Song>) {
  const { togglePlaySong, currentSongId, isPlaying } = useSonataPlayback();
  const isThisPlaying = currentSongId === row.id && isPlaying;
  const primary = placement === "primary";
  return (
    <ControlSizeProvider size={primary ? "lg" : "sm"}>
      <IconButton
        icon={isThisPlaying ? pauseIcon : playArrowIcon}
        label={isThisPlaying ? "Pause" : "Play"}
        variant={primary ? "default" : "ghost"}
        className={primary ? "rounded-full shadow-cover" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          togglePlaySong({ id: row.id, title: row.title });
        }}
      />
    </ControlSizeProvider>
  );
}
