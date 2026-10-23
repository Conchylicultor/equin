import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useSteadyReveal } from "./internal/use-steady-reveal";
export type { RevealTone } from "./internal/reveal-tail";

export default {
  description:
    "Steady reveal for text an agent is still writing: useSteadyReveal drains a growing text at an even pace over the bursts it arrives in, its newest words fading in through a soft tail painted with the CSS Custom Highlight API, in the foreground or muted tone. Shared by the streaming reply and the streaming thought.",
  contributions: [],
} satisfies PluginDefinition;
