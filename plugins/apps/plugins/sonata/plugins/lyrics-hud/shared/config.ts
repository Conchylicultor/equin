import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

/**
 * Lyrics corner options.
 *
 *  - `lyrics` — show the song's lyrics (the line being sung and the next two)
 *    in the display's top-right corner, under the key chip. Off by default: the
 *    roll stays notes only until the user asks for words.
 */
export const lyricsHudConfig = defineConfig({
  fields: {
    lyrics: boolField({
      label: "Lyrics",
      description:
        "Show the line being sung and the next two in the corner, chords over the words.",
      default: false,
    }),
  },
});

/** The lenses the lyrics corner shows over (and whose View popover offers it):
 *  the ones with no lyrics of their own. */
export const LYRICS_HUD_DISPLAYS = ["piano-roll"];
