import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { LyricsHud } from "./components/lyrics-hud";
import { LYRICS_HUD_DISPLAYS, lyricsHudConfig } from "../shared/config";

export default {
  description:
    "Sonata Hud: the song's lyrics in the display's top-right corner, under the key chip — the line being sung and the next two (scroll for the rest, click a line to seek), chords over the words in their degree colours, on a frosted backing that blurs away the notes behind the text. Opt-in from the piano roll's View popover.",
  contributions: [
    Sonata.Hud({ id: "lyrics", component: LyricsHud }),
    ConfigV2.WebRegister({ descriptor: lyricsHudConfig }),
    Sonata.ViewOption({
      id: "lyrics-hud",
      displays: LYRICS_HUD_DISPLAYS,
      config: lyricsHudConfig,
    }),
  ],
} satisfies PluginDefinition;
