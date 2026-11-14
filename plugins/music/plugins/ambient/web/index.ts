import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { createAmbient } from "./internal/ambient";
export type { Ambient, AmbientSfx } from "./internal/ambient";
export { useAmbient } from "./internal/use-ambient";
export type { AmbientHandle, AmbientStatus } from "./internal/use-ambient";

export default {
  description:
    "Generative ambient music in WebAudio, no samples: createAmbient(ctx, { mood }) plays a mood (lofi — a swung 72 bpm Rhodes loop with drums and vinyl crackle; ambient — slow pads, bells, surf and birds) written bar by bar a little ahead of the audio clock, its look-ahead pump woken by the audio clock itself (a silent source's onended, never an interval), with start / stop / setMood / duck and sound effects (step, blip, enter, whoosh); useAmbient({ mood, on }) owns its own AudioContext, created or resumed by unlock() from a user gesture and closed on unmount.",
  contributions: [],
} satisfies PluginDefinition;
