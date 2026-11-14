import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { downloadPage } from "../core";
import {
  WebsiteHeader,
  websitePagePart,
} from "@plugins/apps/plugins/website/plugins/shell/web";

/**
 * The download page at `/about/download` — how to get equin running on your
 * own machine. Wears the shared site header (`actions: WebsiteHeader`); the
 * heading, then the one install band inside `WebsiteChrome`. The body is its
 * own chunk, fetched only where the page is shown.
 */
export const downloadPane = Pane.define({
  route: defineRoute({ id: "website-download", segment: "download" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: downloadPage.title,
  component: websitePagePart(downloadPage, () =>
    import("./components/download-body").then((m) => m.DownloadBody),
  ),
});
