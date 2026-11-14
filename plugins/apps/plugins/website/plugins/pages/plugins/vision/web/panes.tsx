import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { visionPage } from "../core";
import {
  WebsiteHeader,
  websitePagePart,
} from "@plugins/apps/plugins/website/plugins/shell/web";

/**
 * The vision page at `/about/vision` — the vision for applications, as one
 * zoom-out from an idea to every app. Wears the shared site header
 * (`actions: WebsiteHeader`), frosted once the zoom scrolls under it, and
 * renders every `WebsiteVision.Section` contribution below the zoom inside
 * `WebsiteChrome`, so the site footer renders exactly once. The body is its
 * own chunk, fetched only where the page is shown.
 */
export const visionPane = Pane.define({
  route: defineRoute({ id: "website-vision", segment: "vision" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: visionPage.title,
  component: websitePagePart(visionPage, () =>
    import("./components/vision-body").then((m) => m.VisionBody),
  ),
});
