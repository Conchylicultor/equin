import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { BackgroundMusic } from "@plugins/music/plugins/background/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import { SONATA_MUSIC_SOURCE } from "@plugins/apps/plugins/sonata/plugins/player/web";
import {
  PublishSongLabel,
  useSonataBackgroundAvailable,
  useSonataBackgroundHref,
  useSonataBackgroundPlayer,
  useSonataBackgroundTitle,
} from "./internal/music";

export default {
  description:
    "Sonata in the background music service (music/background): a song still playing when the Sonata page went away (Keep playing across apps on) is the service's Sonata source — listed only while there is one, titled with the song and linked to its player page (both published by a Sonata.PlaybackEffect), paused, resumed and stopped from the music button, at the player's own volume.",
  contributions: [
    BackgroundMusic.Source({
      id: SONATA_MUSIC_SOURCE,
      app: sonataApp,
      kind: "Song",
      useTitle: useSonataBackgroundTitle,
      useHref: useSonataBackgroundHref,
      usePlayer: useSonataBackgroundPlayer,
      useAvailable: useSonataBackgroundAvailable,
      ownVolume: true,
    }),
    Sonata.PlaybackEffect({ id: "music-title", component: PublishSongLabel }),
  ],
} satisfies PluginDefinition;
