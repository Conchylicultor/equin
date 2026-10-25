import type { ComponentType } from "react";
import {
  defineRenderSlot,
  defineMountSlot,
} from "@plugins/primitives/plugins/slot-render/web";

/**
 * Slots the browser shell defines for its sub-plugins. Every visible item shape
 * is `{ id; component }`; render with `{(item) => <item.component />}`. Order is
 * registration order (reorder primitive handles user reordering automatically).
 */
export const Browser = {
  /** In-app tab strip (one entry per navigation stack); rendered above the chrome bar. */
  TabStrip: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Tab strip",
  }),
  /** Leading navigation buttons (back/forward/reload/home) in the chrome bar. */
  NavControls: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Navigation controls",
  }),
  /** The address bar; rendered center (flex-1) in the chrome bar. */
  Omnibox: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Omnibox",
  }),
  /** Trailing controls INSIDE the address pill (e.g. the bookmark star). */
  OmniboxAction: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Omnibox action",
  }),
  /** Rows of the site-info popover the address pill's leading button opens (site permissions, cookies, …). */
  SiteInfo: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Site info",
  }),
  /** Trailing chrome-bar actions (open-external). */
  Actions: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Chrome actions",
  }),
  /** Second row below the chrome bar (e.g. bookmarks bar). Empty → nothing. */
  SubBar: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Sub bar",
  }),
  /** The main content area — the webview iframe viewport. */
  Viewport: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Viewport",
  }),
  /** Start page, rendered by the webview when `current === ""`. */
  StartPage: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Start page",
  }),
  /** Headless effects (e.g. history recorder); mounts for side effects only. */
  Effects: defineMountSlot({
    docLabel: () => "Effects",
  }),
};
