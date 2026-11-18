import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useMediaSession,
  type MediaArtwork,
  type MediaSessionClaim,
} from "./internal/use-media-session";
export type { MediaPosition, MediaSessionActions } from "./internal/registry";

export default {
  description:
    "The browser's media session for music played through Web Audio: useMediaSession({ title, artist, artwork, playing, position, actions }) lists the caller's music in Chrome's media controls and the OS's Now Playing / media keys — a detached, looping, near-silent <audio> keeps the session open (Chrome lists only pages a media element plays in) while navigator.mediaSession carries the metadata, play state, scrubber position and action handlers. One session per page: the claim that most recently started playing owns it, the previous taking it back when it goes.",
  contributions: [],
} satisfies PluginDefinition;
