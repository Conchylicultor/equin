import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  Scroll,
  scrollClasses,
  type ScrollProps,
  type ScrollAxis,
} from "./internal/scroll";
export { useScrollsSideways } from "./internal/use-scrolls-sideways";

export default {
  description:
    "Scroll-container layout primitive: <Scroll axis fill> owns overflow AND the flex-child fill policy (min-h-0 flex-1) as one role.",
  contributions: [],
} satisfies PluginDefinition;
