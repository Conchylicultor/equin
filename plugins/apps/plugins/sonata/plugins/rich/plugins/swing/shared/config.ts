import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

/**
 * How the swing shows, per user (not per song — the feel itself is the song's).
 *
 *  - `swingFallingNotes` — draw the falling notes, key lights, effects and the
 *    pedal lane where the swung playback sounds them, so an off-beat reaches
 *    the now-line when it is heard. The notation, progress and loop bounds stay
 *    on the straight grid either way.
 */
export const swingDisplayConfig = defineConfig({
  fields: {
    swingFallingNotes: boolField({
      label: "Swing the falling notes",
      description:
        "Draw the falling notes, key lights and effects where the swung playback sounds them. The notation stays straight.",
      default: true,
    }),
  },
});
