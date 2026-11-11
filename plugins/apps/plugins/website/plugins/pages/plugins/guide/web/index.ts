import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteHeader } from "@plugins/apps/plugins/website/plugins/shell/web";
import { guidePane } from "./panes";
import { WebsiteGuide } from "./slots";
import { GuideNavItem } from "./components/guide-nav-item";

export { guidePane } from "./panes";
export { WebsiteGuide } from "./slots";

export default {
  description:
    "The getting-started guide of the equin website: the /about/guide pane on the first tasks, agents and changes once equin is installed (a placeholder heading for now), its Guide nav link, and the WebsiteGuide.Section slot the guide is written into.",
  contributions: [
    // This pane BORROWS the shared site header (`actions: WebsiteHeader`), so it
    // mints no slot of its own and is deliberately absent from `slots:` — the
    // header is declared once, by `apps.website.shell`.
    Pane.Register({ pane: guidePane }),
    WebsiteHeader({ id: "guide", component: GuideNavItem }),
  ],
  slots: { ...WebsiteGuide },
} satisfies PluginDefinition;
