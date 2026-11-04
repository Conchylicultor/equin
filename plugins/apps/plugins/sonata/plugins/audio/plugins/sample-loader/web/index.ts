import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { sharedSampleLoader } from "./shared-loader";
export type { SampleSource } from "./shared-loader";

export default {
  description:
    "Sonata audio sample loader: one smplr SampleLoader per AudioContext and sample source, shared by every instrument instance built against it, so N copies of an instrument cost one download and one decode instead of N.",
  contributions: [],
} satisfies PluginDefinition;
