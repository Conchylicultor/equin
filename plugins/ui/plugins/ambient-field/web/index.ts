import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { AmbientField } from "./components/ambient-field";
export type { AmbientFieldProps } from "./components/ambient-field";

export default {
  description:
    "<AmbientField>: a living, barely-there background behind its children — hairline strands (iron filings) following a slowly turning flow, drawn on a canvas. Each pointer stroke is a magnet of its own random kind (a pole or a vortex, either sign, its own strength and reach) that turns the strands near it, then fades.",
} satisfies PluginDefinition;
