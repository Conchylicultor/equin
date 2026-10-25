import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";

import { browserApp } from "../core";
import { BrowserLayout } from "./components/browser-layout";
import { Browser } from "./slots";
import { browserTheme } from "./internal/theme";

export { Browser } from "./slots";
export {
  useBrowserNav,
  useBrowserTabs,
  useBrowserProxy,
  BrowserTabsStore,
} from "./nav-store";
export type {
  BrowserNavApi,
  BrowserTab,
  BrowserTabsState,
  BrowserTabSummary,
  BrowserTabsApi,
  BrowserProxyApi,
} from "./nav-store";
export { Favicon, type FaviconProps } from "./components/favicon";

export default {
  description:
    "App shell for the Browser app. Registers the /browser app entry, owns the per-surface tab store (each tab an independent nav stack), defines the Browser.* slots, exports the <Favicon> component, and contributes the app's own theme (the mockup's palette in both modes, the system font at 13px, Lucide icons, its control geometry), which the browser app selects.",
  contributions: [
    Apps.App({
      app: browserApp,
      component: BrowserLayout,
    }),
    // Selected for the browser app in `config/ui/theme-engine/@app/browser/theme.jsonc`.
    ThemeEngine.Theme(browserTheme),
  ],
  slots: Browser,
} satisfies PluginDefinition;
