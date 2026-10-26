import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { usePlayPauseShortcut } from "@plugins/primitives/plugins/shortcuts/web";

/**
 * Space toggles play/pause — a `SonataPlayer.Effect`, so it is registered once
 * per player while that player is SHOWN (a `PlayerDisplay` is mounted): the
 * Sonata app's player pane and a file preview alike, never the library's
 * now-playing bar. The binding and when it yields are `usePlayPauseShortcut`'s,
 * shared with every other player; it closes over THIS player's session, so
 * Space in one window (or preview) never drives another.
 */
export function PlayPauseShortcut() {
  const { togglePlay } = useSession();
  usePlayPauseShortcut(togglePlay);
  return null;
}
