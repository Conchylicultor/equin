import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { floatingToolbar } from "./internal/floating-toolbar";

export default {
  description:
    "Floating toolbar arrangement for the data-view primitive: the band floats over the view (a full-bleed map under it) — the view tabs as a floating card top-left, past the surface's aside, and search, controls, actions and create as a floating card top-right.",
  // A value a surface opts into (`<DataView toolbar={floatingToolbar}>`), not
  // a contribution: the host never looks arrangements up by name.
  contributions: [],
} satisfies PluginDefinition;
