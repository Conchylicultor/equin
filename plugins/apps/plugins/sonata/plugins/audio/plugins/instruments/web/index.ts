import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataAudio } from "./slots";

export { SonataAudio } from "./slots";
export type {
  InstrumentAssets,
  InstrumentVoices,
  ScheduledNote,
} from "./slots";
export { useInstrumentAssets } from "./assets";

export default {
  description:
    "Sonata audio Instrument axis: the SonataAudio.Instrument slot and its voice contracts (InstrumentVoices, ScheduledNote, and InstrumentAssets — the samples resolved over the host transport, read with useInstrumentAssets) — an audio contract a host with an AudioContext can consume without importing the Sonata app shell.",
  contributions: [],
  slots: SonataAudio,
} satisfies PluginDefinition;
