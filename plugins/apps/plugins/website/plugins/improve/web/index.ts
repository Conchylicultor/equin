import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { WebsiteHeader } from "@plugins/apps/plugins/website/plugins/shell/web";
import { ImproveNavItem } from "./components/improve-nav-item";

export default {
  description:
    "The website's Wish button: the header's call to action, a popover where a visitor describes a change to the page, watches a scripted replay of what equin would do with it, and files it as a prefilled GitHub issue.",
  contributions: [
    // Last in the header, after the destinations — see
    // `config/apps/website/shell/header.jsonc`.
    WebsiteHeader({ id: "improve", component: ImproveNavItem }),
  ],
} satisfies PluginDefinition;
