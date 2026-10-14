import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Library } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { hydrate } from "./hydrate";
import { transcribeCreateOption } from "./components/transcribe-create-option";
import { transcriptionPresentation } from "./internal/presentation";

export default {
  description:
    "Sonata transcription in the library: a 'Transcribe…' entry in the + menu (a video/post link, or page images and PDFs) that creates the song and starts the transcribing agent; a transcribed song shows its live run state in the player until the score is in (Open conversation, and the error + Retry when it failed); and a Transcribing / Failed badge on its card.",
  contributions: [
    Library.Source({
      sourceId: "transcription",
      hydrate,
      createOption: transcribeCreateOption,
    }),
    transcriptionPresentation,
  ],
} satisfies PluginDefinition;
