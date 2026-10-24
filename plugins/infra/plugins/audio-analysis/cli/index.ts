import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin audio …` — run audio analyses from a terminal, in the
 * foreground, with the same `ensureBeatFeatures` the job runs. Boots this
 * checkout's backend in `exec` mode (the deps and the jobs are server
 * contributions), so the checkout must have been built once.
 */
export default defineCliCommand({
  name: "audio",
  description: "Audio analysis of YouTube videos (beat features, …)",
  subcommands: [
    defineCliCommand<
      [string[]],
      {
        force?: boolean;
        clicks?: string;
        device?: string;
        beatModel?: string;
        chroma?: string;
      }
    >({
      name: "features",
      description:
        "Beat features of each video (downloading, installing and analysing on first use), with a per-song summary: beats, median BPM, downbeat spacing",
      arguments: [
        { name: "<videoId...>", description: "YouTube video ids (or URLs)" },
      ],
      options: [
        {
          flags: "--force",
          description: "Re-analyse even when the features are cached",
        },
        {
          flags: "--clicks <dir>",
          description:
            "Also write <dir>/<videoId>-clicks.wav: a click on every beat (accented on downbeats) over the audio",
        },
        {
          flags: "--device <device>",
          description:
            "Where the beat tracker runs: auto, cpu or mps (default: the configured one)",
        },
        {
          flags: "--beat-model <model>",
          description:
            "The Beat This! checkpoint: small0 or final0 (default: the configured one)",
        },
        {
          flags: "--chroma <variant>",
          description:
            "The chroma variant: fast or full (default: the configured one)",
        },
      ],
      run: () => import("./internal/features"),
    }),
  ],
});
