import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { createAmbient } from "./internal/ambient";
export type { Ambient, AmbientSfx } from "./internal/ambient";
export { createAmbientHost, useAmbientHost } from "./internal/ambient-host";
export type {
  AmbientHost,
  AmbientSnapshot,
  AmbientStatus,
} from "./internal/ambient-host";

export default {
  description:
    "Generative ambient music in WebAudio, no samples: createAmbient(ctx, { mood }) plays a mood (lofi — a swung 72 bpm Rhodes loop with drums and vinyl crackle; bossa — an 84 bpm nylon guitar over shaker and rim clave; nocturne — a rolled piano in 3/4 with crickets and music-box fireflies; ambient — slow pads, bells, surf and birds), each an endless procedural form rather than a loop — core's createComposer walks sections (intro, verse, chorus, bridge, break) over the mood's progressions, moves key now and then, and gives each section a melodic motif stated, answered and varied, fresh from a new seed every start — written bar by bar a little ahead of the audio clock, its look-ahead pump woken by the audio clock itself (a silent source's onended, never an interval), with start / stop / setMood / duck / setGain and sound effects (step, blip, enter, whoosh, chime); createAmbientHost() is one engine shared by everything on the page that holds it (a view and a background player alike): its AudioContext built suspended on the first retain (constructing one blocks the main thread while the browser opens the audio output, so never inside a gesture), resumed by unlock() or set({ on: true }), closed on the last release; useAmbientHost(host) holds it while mounted and reads its status.",
  contributions: [],
} satisfies PluginDefinition;
