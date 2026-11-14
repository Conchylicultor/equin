import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { appsPage } from "../core";
import {
  WebsiteHeader,
  websitePagePart,
} from "@plugins/apps/plugins/website/plugins/shell/web";

/**
 * The apps gallery at `/about/apps` — every app equin ships, searchable and
 * grouped by category. Wears the shared site header (`actions: WebsiteHeader`);
 * the heading with the search under it, then one body band holding the
 * gallery, the "Missing an app?" card and the two pages to read next, inside
 * `WebsiteChrome`. The body is its own chunk, fetched only where the page is
 * shown.
 */
export const appsPane = Pane.define({
  route: defineRoute({ id: "website-apps", segment: "apps" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: appsPage.title,
  component: websitePagePart(appsPage, () =>
    import("./components/apps-body").then((m) => m.AppsBody),
  ),
});
