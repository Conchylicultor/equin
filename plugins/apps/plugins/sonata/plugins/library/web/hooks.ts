import { useCallback } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useSonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { sonataPlayerPane } from "./panes";
import { requestPlayOnOpen } from "./play-on-open";

/**
 * Open a song into the player — as a link (`{ open, href }`), so the control
 * that opens it gets middle- / ⌘-click into a new browser tab. Navigates (via the pane router) to the player
 * pane at `/sonata/song/:songId`, replacing the route (`mode:"root"`) so the
 * player fills the surface. The optimistic title rides in `input` so the header
 * shows immediately. Source hydration runs in the player pane's `useResolve` hook
 * (`useSonataPlayerResolve`) — including on direct navigation / reload — so this
 * hook just opens the pane.
 *
 * Opening a song here starts it playing ({@link requestPlayOnOpen}) — the
 * click is the user's ask to hear it. A song already loaded (reopened from the
 * now-playing bar) is not reloaded, so it keeps playing or stays paused as it
 * was; a new browser tab (`href`) opens it paused, like a reload.
 *
 * Used by the gallery cards (a component, so the caller-aware context store is
 * correct). Sources' `createOption.onSelect` paths are plain data with no
 * component to host a hook — they are handed `useOpenSong`'s opener instead.
 */
export function useSongLink(): (song: {
  id: string;
  title: string;
}) => LinkTarget {
  const openPane = useOpenPane();
  const { currentSongId } = useSonataApp();
  return useCallback(
    (song) => {
      const target = openPane.to(
        sonataPlayerPane,
        { songId: song.id },
        { mode: "root", hint: { title: song.title } },
      );
      return {
        open: (gesture) => {
          if (song.id !== currentSongId) requestPlayOnOpen(song.id);
          target.open(gesture);
        },
        href: target.href,
      };
    },
    [openPane, currentSongId],
  );
}
