import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Surface, type SurfaceProps } from "./internal/surface";

export default {
  description:
    "Semantic surface elevation primitive: <Surface level> bundles background + border + radius + shadow into a closed set of roles (sunken/base/raised/overlay, and float — glass for floating chrome), plus the no-adhoc-surface lint rule.",
  contributions: [],
} satisfies PluginDefinition;
