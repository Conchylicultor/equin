import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  fullscreenSupport,
  useFullscreenSupport,
  type FullscreenSupport,
} from "./internal/fullscreen-support";

export default {
  description:
    "The browser's element fullscreen, only where it exists: fullscreenSupport(doc?) answers unsupported (an iPhone has no element fullscreen; a frame without allowfullscreen may not use it) or supported with request(el) — so a caller must branch before it can ask — and useFullscreenSupport() reads it while rendering, for a control that is not offered where the browser cannot do it. Its lint rule (no-raw-request-fullscreen) sends every other .requestFullscreen() call here.",
  contributions: [],
} satisfies PluginDefinition;
