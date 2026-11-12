import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteHeader } from "@plugins/apps/plugins/website/plugins/shell/web";
import { downloadPane } from "./panes";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { DownloadNavItem } from "./components/download-nav-item";
import {
  equinDownloadNoteTheme,
  equinDownloadTabsTheme,
  equinDownloadTheme,
} from "./internal/theme";

export { downloadPane } from "./panes";

export default {
  description:
    "The download page of the equin website: the /about/download pane with the one install command (or, for an agent, a prompt with deep links into Claude Code and the Claude app), what to do once it runs, a closing card opening the homepage's live demo full screen for a reader not ready to install (agents off there), and its Download nav link.",
  contributions: [
    // This pane BORROWS the shared site header (`actions: WebsiteHeader`), so it
    // mints no slot of its own — the header is declared once, by
    // `apps.website.shell`.
    Pane.Register({ pane: downloadPane }),
    WebsiteHeader({ id: "download", component: DownloadNavItem }),
    // The page body's sizes and its caveats note's and its audience switch's, each worn over the site's
    // equin-document by its own region of the page.
    ThemeEngine.SubTheme(equinDownloadTheme),
    ThemeEngine.SubTheme(equinDownloadNoteTheme),
    ThemeEngine.SubTheme(equinDownloadTabsTheme),
  ],
} satisfies PluginDefinition;
