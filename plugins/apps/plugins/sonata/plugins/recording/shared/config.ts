import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

// The recording mix, shared by the web (read + write + register) and server
// (register) runtimes. One per app, not per song: how loud the video is and how
// late the iframe's sound comes out are facts about the listener and the
// machine, not about a song. The synth's level is NOT here — it is the audio
// engine's master volume, so there is one gain for it.
export const recordingConfig = defineConfig({
  name: "sonata.recording",
  fields: {
    videoOn: boolField({
      label: "Video sound",
      description:
        "Hear the recording. Off mutes it; it keeps playing and keeping time.",
      default: true,
    }),
    videoVolume: intField({
      label: "Video volume",
      description: "Loudness of the recording, 0–100.",
      default: 100,
      min: 0,
      max: 100,
      step: 1,
    }),
    // The YouTube iframe's sound comes out later than the time it reports (its
    // own buffering and output path), by an amount that depends on the
    // machine. A positive offset plays the synth (and moves the playhead)
    // that much later, so it lands on the recording's beat.
    syncOffsetMs: intField({
      label: "Sync offset",
      description:
        "Milliseconds the synth plays after the recording's reported time (negative = earlier). Tune it by ear until both land together.",
      default: 0,
      min: -500,
      max: 500,
      step: 10,
    }),
  },
});

// Whether the recording's video plays at all — its own document, apart from the
// mix: off, no player exists and the synth plays alone, on the same (aligned)
// timing. Distinct from `videoOn`, which only mutes the video.
export const recordingVideoConfig = defineConfig({
  name: "sonata.recording-video",
  fields: {
    playVideo: boolField({
      label: "Play the video",
      description:
        "Play the song's recording video along with the song. Off, the synth plays alone, on the same timing.",
      default: true,
    }),
  },
});
