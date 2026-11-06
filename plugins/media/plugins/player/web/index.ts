import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import {
  mediaPlayerTheme,
  mediaSettingsTheme,
  mediaVolumeTheme,
} from "./internal/theme";

export { MediaPlayer, type MediaPlayerProps } from "./components/media-player";

export default {
  description:
    "Themed video / audio player in place of the browser's native controls: a floating glass control pill (play, volume, time, seek, settings, full screen) that fades while playing, a vertical volume capsule, a settings panel with a fine speed dial (0.25–3×), presets, loop and picture in picture (a Document Picture-in-Picture window holding the whole player, falling back to the video's own), centre feedback and the YouTube-style keyboard. Audio draws the same controls as a static bar.",
  contributions: [
    ThemeEngine.FixedTheme(mediaPlayerTheme),
    ThemeEngine.SubTheme(mediaSettingsTheme),
    ThemeEngine.SubTheme(mediaVolumeTheme),
  ],
} satisfies PluginDefinition;
