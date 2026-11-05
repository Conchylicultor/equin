import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { PageRenderOrigin } from "./internal/render-origin";

export {
  RenderOrigin,
  useRenderOrigin,
  type Raised,
  type RaiseOptions,
  type RenderOriginHandle,
} from "./internal/render-origin";

export default {
  description:
    "Where content a caller hands to page chrome renders: <RenderOrigin> marks a subtree's own origin, and useRenderOrigin() captures the caller's (the nearest one, else outside every PluginScope the page's, mounted at Core.Root) — raise(node) renders it there, under the caller's transport, registry and navigator, while the chrome only places it. Inside a PluginScope with no origin of its own, useRenderOrigin throws rather than fall through to the page's.",
  contributions: [Core.Root({ component: PageRenderOrigin })],
} satisfies PluginDefinition;
