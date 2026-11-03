import type { ReactNode } from "react";
import { PlayerTransport } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useSongLink } from "../hooks";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useCurrentSong } from "../use-current-song";
import type { Song } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const musicNoteIcon = symbol("music-note");

/**
 * Compact now-playing bar at the bottom of the library. Shown while a song is
 * loaded in the app's player — a card/row "Play" loaded one in the background,
 * or the user left the player with its song still loaded — and `null` before
 * any. It surfaces the playback that outlives the player pane: the song
 * identity and the shared transport strip (play / pause, scrubber, loop).
 * Clicking the title reopens the player on it, still playing where it was. The title is read from the canonical library
 * row (`useCurrentSong`), never a shell-context mirror.
 */
export function NowPlayingBar() {
  const current = useCurrentSong();
  const songLink = useSongLink();
  // While the open song's row loads — pressing Play on another song mints a
  // new point read — the bar STAYS and only its title waits (a shimmer, or the
  // read's error over the row as last seen), so a song change never blinks the
  // bar out and back.
  let song: Song | undefined;
  switch (current.status) {
    case "loading":
      song = undefined;
      break;
    case "error":
      song = current.stale;
      break;
    case "ready":
      // No song open, or the open id names no song: no bar.
      if (!current.found) return null;
      song = current.row;
      break;
  }
  return (
    <div className="border-t border-border bg-background">
      <Inset x="xl" y="sm">
        <Stack direction="row" align="center" gap="md">
          <Center className="size-8 rounded-md bg-primary/10 text-primary-text">
            <Icon icon={musicNoteIcon} className="size-4" />
          </Center>
          {/* Title block — rigid (capped width), title truncates in its Line. */}
          {song !== undefined ? (
            <button
              type="button"
              aria-label={`Open ${song.title} in player`}
              {...linkProps(songLink({ id: song.id, title: song.title }))}
              className="w-44 text-left hover:underline"
            >
              <NowPlayingTitle>
                <Text variant="caption" className="font-medium text-foreground">
                  {song.title}
                </Text>
              </NowPlayingTitle>
            </button>
          ) : (
            <div className="w-44">
              <NowPlayingTitle>
                {current.status === "error" ? (
                  <ResourceErrorInline
                    error={current.error}
                    refetch={current.refetch}
                    variant="inline"
                  />
                ) : (
                  <Loading variant="block" className="h-4 w-32" />
                )}
              </NowPlayingTitle>
            </div>
          )}
          {/* The shared transport strip: play / pause, the scrubber for
              seeking, and the loop toggle. */}
          <Fill>
            <PlayerTransport />
          </Fill>
        </Stack>
      </Inset>
    </div>
  );
}

/** The title block's two lines: the "Now playing" eyebrow over the title slot. */
function NowPlayingTitle({ children }: { children: ReactNode }) {
  return (
    <Stack gap="none">
      <Text variant="eyebrow" tone="muted">
        Now playing
      </Text>
      <Line>{children}</Line>
    </Stack>
  );
}
