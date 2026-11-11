import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  createStaticRenderer,
  StaticRenderError,
} from "./internal/static-renderer";
export type { StaticPage, StaticRenderer } from "./internal/static-renderer";
export { StaticRenderNetworkError } from "./internal/static-transport";

export default {
  description:
    "One static render of a pane to HTML for robots (never hydrated): createStaticRenderer declares the process a static render, loads the composition's plugins, hydrates a boot snapshot through the boot task's own hydrate path, and renders a path through the real provider stack and a static pane store, failing loudly with the pane and the component path.",
  contributions: [],
} satisfies PluginDefinition;
