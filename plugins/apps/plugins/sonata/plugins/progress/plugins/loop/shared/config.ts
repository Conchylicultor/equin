import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

/**
 * How an enabled A–B loop repeats — user preferences (global, not per loop),
 * edited from the Loop control's options menu and pushed into the playback
 * session (`setLoopOptions`), which owns what they mean.
 *
 *  - `showAhead` — past B, the falling notes show the loop repeating instead
 *    of the rest of the song (`LoopOptions.ahead`).
 *  - `restBeforeRepeat` — one empty bar before every repeat, so the next pass
 *    can be seen coming (`LoopOptions.rest`). Real time: the audio, the
 *    metronome and the cursor all rest.
 */
export const loopConfig = defineConfig({
  fields: {
    showAhead: boolField({
      label: "Show loop ahead",
      description:
        "After B, the falling notes show the loop again instead of the rest of the song.",
      default: true,
    }),
    restBeforeRepeat: boolField({
      label: "Rest before repeat",
      description:
        "Wait one empty bar before each repeat, to see the loop coming.",
      default: true,
    }),
  },
});
