import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataAudio } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import { ExternalHosts } from "@plugins/framework/plugins/browser-server/web";
import { createVoices } from "./voices";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Sonata Instrument: a sampled acoustic grand piano (smplr SplendidGrandPiano) that sounds the Score during playback.",
  contributions: [
    // A browser host's asset mirror fetches the samples from the CDN itself
    // (memory cache, no disk): the one host it reaches.
    ExternalHosts.Declare({
      hosts: ["smpldsnds.github.io"],
      reason:
        "The grand piano's samples (the splendid-grand-piano asset mirror's remote).",
    }),
    SonataAudio.Instrument({
      id: "piano",
      label: "Acoustic Piano",
      icon: symbol("piano"),
      // The premium sampled grand owns GM program 0 (acoustic grand piano) and
      // is the fallback for tracks with no program/override. The soundfont set
      // covers programs 1-127, so there is no program overlap.
      gmProgram: 0,
      group: "Piano",
      default: true,
      createVoices,
    }),
  ],
} satisfies PluginDefinition;
