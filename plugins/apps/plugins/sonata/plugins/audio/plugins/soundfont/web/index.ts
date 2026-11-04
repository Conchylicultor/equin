import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataAudio } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/instruments/web";
import { GM_INSTRUMENTS, familyIcon } from "./gm";
import { createSoundfontVoices } from "./voices";

export default {
  description:
    "Sonata Instruments: the full General MIDI melodic set (programs 1-127) backed by smplr's Soundfont, served same-origin via the asset-mirror (offline after first warm-up). Program 0 (acoustic grand) is owned by the dedicated sampled-piano plugin.",
  // One plugin registers many Instrument contributions: the GM table filtered to
  // programs 1-127 (program 0 is the premium sampled piano + default fallback).
  // Each timbre is a smplr Soundfont bound to one gleitz patch slug. No entry
  // sets `default` — the piano stays the fallback.
  contributions: GM_INSTRUMENTS.filter((gm) => gm.program >= 1).map((gm) =>
    SonataAudio.Instrument({
      id: `sf:${gm.program}`,
      label: gm.name,
      icon: familyIcon[gm.family],
      gmProgram: gm.program,
      group: gm.family,
      createVoices: (ctx, destination, assets) =>
        createSoundfontVoices(ctx, destination, assets, gm.gleitz),
    }),
  ),
} satisfies PluginDefinition;
