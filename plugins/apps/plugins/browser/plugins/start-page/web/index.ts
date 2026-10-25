import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Browser } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { StartPage } from "./components/start-page";

export default {
  description:
    "Browser start page: the empty-state landing shown in the viewport when no URL is loaded — a centered hero (time-of-day greeting + pill search), a grid of pins (curated quick links, then the live bookmarks), and the recently visited pages.",
  contributions: [Browser.StartPage({ id: "start-page", component: StartPage })],
} satisfies PluginDefinition;
