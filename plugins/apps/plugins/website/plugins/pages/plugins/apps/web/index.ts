import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteHeader } from "@plugins/apps/plugins/website/plugins/shell/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { appsPane } from "./panes";
import { AppsNavItem } from "./components/apps-nav-item";
import { equinClosingTheme, equinGalleryTheme } from "./internal/theme";

export { appsPane } from "./panes";

export default {
  description:
    "The apps gallery of the equin website: the /about/apps pane listing every app equin ships, searchable and grouped by category (harness, daily life, tools, coming next), each card's Install and the 'Missing an app?' band going to the download page, the vision and foundations pages offered at its end, and its Apps nav link.",
  contributions: [
    // This pane BORROWS the shared site header (`actions: WebsiteHeader`), so it
    // mints no slot of its own — the header is declared once, by
    // `apps.website.shell`.
    Pane.Register({ pane: appsPane }),
    WebsiteHeader({ id: "apps", component: AppsNavItem }),
    // The gallery's and the page end's sizes, each worn over the site's
    // equin-document by its own region of the page.
    ThemeEngine.SubTheme(equinGalleryTheme),
    ThemeEngine.SubTheme(equinClosingTheme),
  ],
} satisfies PluginDefinition;
