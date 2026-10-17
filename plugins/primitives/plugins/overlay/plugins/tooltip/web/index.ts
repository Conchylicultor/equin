import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Kbd, type KbdProps } from "./components/kbd";
export { WithTooltip, type WithTooltipProps } from "./components/with-tooltip";
export { usePinOnClick } from "./components/use-pin-on-click";
export { TooltipDoc, type TooltipDocProps } from "./components/tooltip-doc";

export default {
  description:
    "WithTooltip wrapper, usePinOnClick (click pins a tooltip open — shared with the hover card), <TooltipDoc> documenting tooltip body (name + what it does), and <Kbd> keyboard shortcut badge.",
  contributions: [],
} satisfies PluginDefinition;
