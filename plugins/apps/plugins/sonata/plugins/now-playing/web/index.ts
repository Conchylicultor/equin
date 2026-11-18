import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { SonataNowPlaying } from "./internal/now-playing";

export default {
  description:
    "The playing Sonata song in the browser's media session (media/media-session): Chrome's media controls and the OS's Now Playing / media keys show its title with the Sonata icon, a scrubber over the tempo-scaled song, and play / pause / seek driving the playback session. A Sonata.PlaybackEffect, so it follows the song when it plays on with no Sonata page shown (Sonata's background music source leaves the session to it).",
  contributions: [
    Sonata.PlaybackEffect({ id: "now-playing", component: SonataNowPlaying }),
  ],
} satisfies PluginDefinition;
