import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Library } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { hydrate } from "./hydrate";
import { transcribeCreateOption } from "./components/transcribe-create-option";
import { transcriptionPresentation } from "./internal/presentation";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  TranscriptionSection,
  useTranscriptionSectionAvailable,
} from "./components/transcription-section";

export default {
  description:
    "Sonata transcription in the library: a 'Transcribe…' entry in the + menu (a video/post link, or page images and PDFs) that creates the song and starts the transcribing agent; a transcribed song shows its agent run as an embedded agent thread — the steps, the agent's summary and a reply box — in the player until the score is in (Retry when it failed), then in the player's Transcription section, where a reply asks for a correction and the resubmitted score replaces the song's; and a Transcribing / Failed badge on its card.",
  contributions: [
    Library.Source({
      sourceId: "transcription",
      hydrate,
      createOption: transcribeCreateOption,
    }),
    transcriptionPresentation,
    Sonata.Section({
      id: "transcription",
      label: "Transcription",
      icon: symbol("music-note"),
      component: TranscriptionSection,
      area: "editor",
      useAvailable: useTranscriptionSectionAvailable,
    }),
  ],
} satisfies PluginDefinition;
