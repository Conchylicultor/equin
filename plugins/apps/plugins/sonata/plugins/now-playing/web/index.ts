import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { SonataNowPlaying } from "./internal/now-playing";

export default {
  description:
    "A Sonata player's song in the browser's media session (media/media-session): Chrome's media controls and the OS's Now Playing / media keys show its name (a library song's live title, a file's name — from the song document) with the Sonata icon, a scrubber over the tempo-scaled song, and play / pause / seek driving the playback session. A SonataSession.Effect, so every player claims it — the Sonata app's (following its song when it plays on with no Sonata page shown; Sonata's background music source leaves the session to it), a file preview's and a mini player's — and the one that started playing last owns the session.",
  contributions: [
    SonataSession.Effect({ id: "now-playing", component: SonataNowPlaying }),
  ],
} satisfies PluginDefinition;
