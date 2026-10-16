import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { PinLayer } from "./internal/pin-layer";
export type { LayerFrame, SceneItem } from "./internal/pin-layer";
export { createCanvas2dPainter } from "./internal/painter";
export type { PaintText, PinPainter } from "./internal/painter";

export default {
  description:
    "The map's pin layer, vendor-neutral: PinLayer holds every pin at rest as a scene of marks and draws a frame from a projection — one sprite per pin on one surface (marks rasterized once per look, a new scene swapped in whole once its sprites are ready), texts beside or inside marks in map-label paint, and hit testing from the last frame's boxes; drawing goes through the PinPainter seam (createCanvas2dPainter today). A renderer hosts it on its map and lifts only the pins being interacted with into the DOM.",
  contributions: [],
} satisfies PluginDefinition;
