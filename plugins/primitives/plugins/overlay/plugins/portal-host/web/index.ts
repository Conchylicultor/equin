import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  PortalContainerProvider,
  PortalHost,
  usePortalContainer,
} from "./internal/portal-host";

export default {
  description:
    "Where a popup opened inside a region is drawn: PortalHost makes every ui-kit popup (popover, menu, select, tooltip, dialog, sheet) opened inside it render into the region instead of document.body — required under the Fullscreen API, which paints only the fullscreen element's subtree, and over overlays stacked above the popup layer. ui-kit's portal wrappers read usePortalContainer. Imports only react, so ui-kit can consume it without a cycle.",
  contributions: [],
} satisfies PluginDefinition;
