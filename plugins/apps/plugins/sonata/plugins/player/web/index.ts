import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataPlayer } from "./slots";

export { SonataPlayer } from "./slots";
export { SonataPlayerScope } from "./scope";
export { PlayerDisplayBinding, usePlayerView, type PlayerView } from "./view";
export { PlayerDisplay, PlayerTransport, PlayerTime } from "./components/parts";
export { useDisplayCover, type DisplayCover } from "./cover";

export default {
  description:
    "Sonata player: SonataPlayerScope, the one composition root of a player (cursor store > song document > playback session > player view, with the per-session effects and a library song's setting observers), and the parts a host composes inside it — PlayerDisplay, PlayerTransport (the strip row of every Transport contribution: play, scrubber, loop), PlayerTime. Owns the SonataPlayer.{Display,Transport,Effect} slots — Effect mounting once per player while a PlayerDisplay shows it (the keyboard transport) — and the per-player view state (display lens, piano-roll spread, shown), whose display pick a host can bind to its own value (a URL param) with PlayerDisplayBinding.",
  slots: { ...SonataPlayer },
} satisfies PluginDefinition;
