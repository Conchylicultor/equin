import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  MINI_PLAYER_HEADER_HEIGHT,
  SonataMiniPlayer,
} from "./components/mini-player";

export default {
  description:
    "Sonata's mini player: <SonataMiniPlayer> — one song (a library song or a file's bytes) in a player of its own, drawn as the immersive player scaled down and wearing Sonata's theme wherever it is hosted: the falling notes fill the box, an optional header band floats over their top, and the progression capsule (play, the timeline, loop) floats in glass. One loading state until the display has drawn, then everything at once and it plays. Shared by the file viewer's MIDI preview and the song peek pane.",
  contributions: [],
} satisfies PluginDefinition;
