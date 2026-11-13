import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { BrowserExtension } from "@plugins/companions/plugins/browser-extension/web";
import { openLocally, openOnPublicSite } from "./internal/actions";

export default {
  description:
    "The equin site's page actions in the browser extension: on equin.ai, 'Open locally' (the same page on the local instance — the site's paths are the website app's, so it is an origin swap); on any local equin page, 'Open on equin.ai' (a website page at the same path, any other page at the site's home). The mapping is the website's own (apps/website/shell core); this leaf only offers it, so the website's composition never carries the extension.",
  contributions: [
    BrowserExtension.PageAction(openLocally),
    BrowserExtension.PageAction(openOnPublicSite),
  ],
} satisfies PluginDefinition;
