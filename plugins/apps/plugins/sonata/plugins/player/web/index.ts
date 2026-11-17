import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataPlayer } from "./slots";

export { SonataPlayer } from "./slots";
export {
  SONATA_MUSIC_SOURCE,
  SonataPlayerScope,
  usePlaybackInstanceKey,
} from "./scope";
export {
  useBackgroundPlaybackPlayer,
  useBackgroundPlaybackLabel,
  useHasBackgroundPlayback,
  usePublishPlaybackLabel,
} from "./instance-music";
export type { PlaybackLabel } from "./internal/instances";
export {
  PlayerDisplayBinding,
  useMarkDisplayDrawn,
  usePlayerView,
  type PlayerView,
} from "./view";
export { PlayerDisplay, PlayerTransport, PlayerTime } from "./components/parts";
export { useDisplayCover, type DisplayCover } from "./cover";

export default {
  description:
    "Sonata player: SonataPlayerScope, the one composition root of a player (cursor store > song document > playback session > player view, with the per-session effects and a library song's setting observers) — local (the song ends with the scope: a file preview), or, given an instance key (the Sonata app: its tab), a page-level playback instance raised at the view's render origin that the view attaches to through relayed contexts, so the song outlives the view: leaving while it plays hands it to the background music service (kept across apps, it plays on as the page's one background instance, driven from the music button; otherwise it ends), and a view coming back finds it where it is. and the parts a host composes inside it — PlayerDisplay, PlayerTransport (the strip row of every Transport contribution: play, scrubber, loop), PlayerTime. Owns the SonataPlayer.{Display,Transport,Effect} slots — Effect mounting once per player while a PlayerDisplay shows it (the keyboard transport) — and the per-player view state (display lens, piano-roll spread, shown, drawn — each display reports when it has drawn with useMarkDisplayDrawn), whose display pick a host can bind to its own value (a URL param) with PlayerDisplayBinding.",
  slots: { ...SonataPlayer },
} satisfies PluginDefinition;
