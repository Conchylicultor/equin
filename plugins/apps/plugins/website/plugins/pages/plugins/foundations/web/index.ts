import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Website } from "@plugins/apps/plugins/website/plugins/shell/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { foundationsPane } from "./panes";
import { FoundationsNavItem } from "./components/foundations-nav-item";
import { icebergSeaHeaderTheme, icebergSkyHeaderTheme } from "./internal/theme";

export { foundationsPane } from "./panes";

export default {
  description:
    "The technical foundations page of the equin website: the /about/foundations pane drawing what equin brings on top of Claude as an iceberg — ten layers from the apps at sea level down to the loop that builds them, each piece a pill that opens in place into a card (many with a live drawing), with a depth gauge, a Components / Harness filter and Expand all — and its entry in the header's Learn menu.",
  contributions: [
    // This pane BORROWS the shared site header (`actions: WebsiteHeader`), so it
    // mints no slot of its own and is deliberately absent from `slots:` — the
    // header is declared once, by `apps.website.shell`.
    Pane.Register({ pane: foundationsPane }),
    Website.LearnEntry({
      id: "foundations",
      label: "Foundations",
      component: FoundationsNavItem,
    }),
    // The header's two dresses: over the sunlit sky, and over the black water.
    ThemeEngine.SubTheme(icebergSkyHeaderTheme),
    ThemeEngine.SubTheme(icebergSeaHeaderTheme),
  ],
} satisfies PluginDefinition;
