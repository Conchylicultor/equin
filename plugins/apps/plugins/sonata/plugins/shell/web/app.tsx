import { useMemo } from "react";
import { useLibrarySong } from "@plugins/apps/plugins/sonata/plugins/document/web";

/**
 * The Sonata APP's view of its song: which library song is in play. Derived
 * from the player scope's loaded document — never kept beside it — so it holds
 * the song that will sound when Play is pressed, whether a player pane shows it
 * or it plays in the background from the library.
 *
 * It carries no content and no load count: an effect that pairs the song with
 * its content or its load reads them as one value from the document
 * (`useSourceEdit`, `useLibrarySongLoad`), never this id beside another read.
 */
export interface SonataAppValue {
  /** Id of the library song loaded in the app (null before any load). Lets
   *  the library show which song is playing. */
  currentSongId: string | null;
}

/** Read the Sonata app state. Must be called inside the app's player scope. */
export function useSonataApp(): SonataAppValue {
  const song = useLibrarySong();
  const currentSongId = song.kind === "library" ? song.songId : null;
  return useMemo(() => ({ currentSongId }), [currentSongId]);
}
