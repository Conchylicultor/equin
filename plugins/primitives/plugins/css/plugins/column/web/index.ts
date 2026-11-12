import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Column, type ColumnProps } from "./internal/column";
export { Band, type BandProps, type BandRule } from "./internal/band";

export default {
  description:
    "Vertical named-slot layout primitive: <Column header body footer> stacks a rigid header, a flexible scrolling body, and a rigid footer in one flex column. Owns the rigid|flexible|rigid fill policy (shrink-0 header/footer, Scroll body); callers write roles, never shrink-0/min-h-0/flex-1 mechanics. `inset` makes each region (header, body scroller, footer) a region owner at that step (rail-x-<step> + rail-rows), `rules` draws its header/footer hairlines; <Band rule> is the rule-bearing strip mid-content, its text on the host's text rail.",
  contributions: [],
} satisfies PluginDefinition;
