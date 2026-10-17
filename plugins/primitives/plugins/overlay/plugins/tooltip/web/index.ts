import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Kbd, type KbdProps } from "./components/kbd";
export { TooltipDoc, type TooltipDocProps } from "./components/tooltip-doc";

export default {
  description:
    "<TooltipDoc> documenting tooltip body (name + what it does), and <Kbd> keyboard shortcut badge.",
  contributions: [],
} satisfies PluginDefinition;
