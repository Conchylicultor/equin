import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  NoStaticValueError,
  useBrowserValue,
  useMediaQuery,
  useOwnedElement,
  useViewportSize,
  type BrowserValueOptions,
  type ViewportSize,
} from "./internal/browser-value";

export default {
  description:
    "Reading the browser while rendering, safely in both modes: useBrowserValue({ name, read, subscribe?, staticValue? }) (live: useSyncExternalStore, re-read on every change; static: staticValue, or a loud NoStaticValueError), useMediaQuery(query, staticValue), useViewportSize(staticValue), and useOwnedElement(name, create) — a DOM node a component mints once, which has no static form. The one place a render-time read of window / document / navigator / matchMedia happens (dom-access-safety/no-render-time-dom).",
  contributions: [],
} satisfies PluginDefinition;
