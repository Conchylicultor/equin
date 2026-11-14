import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { foundationsPage } from "../core";
import {
  WebsiteHeader,
  websitePagePart,
} from "@plugins/apps/plugins/website/plugins/shell/web";

/**
 * The foundations page at `/about/foundations` — what equin brings on top
 * of Claude, drawn as an iceberg. Wears the shared site header
 * (`actions: WebsiteHeader`) inside `WebsiteChrome`, so the site footer renders
 * exactly once. The header stays pinned and frosts once the page moves, dressed
 * for what is under it. The body is its own chunk, fetched only where the page
 * is shown.
 */
export const foundationsPane = Pane.define({
  route: defineRoute({ id: "website-foundations", segment: "foundations" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: foundationsPage.title,
  component: websitePagePart(foundationsPage, () =>
    import("./components/foundations-body").then((m) => m.FoundationsBody),
  ),
});
