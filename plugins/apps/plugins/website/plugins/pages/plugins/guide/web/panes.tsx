import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { guidePage } from "../core";
import {
  WebsiteChrome,
  WebsiteHeader,
  WebsiteSoon,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { WebsiteGuide } from "./slots";
import { GuideOpening } from "./components/guide-opening";

/**
 * The getting-started guide at `/website/guide` — what to do once equin is
 * running. Wears the shared site header (`actions: WebsiteHeader`), and renders
 * every `WebsiteGuide.Section` contribution below the heading inside
 * `WebsiteChrome`. Unwritten so far, so the heading is followed by the site's
 * "more details soon" note.
 */
export const guidePane = Pane.define({
  route: defineRoute({ id: "website-guide", segment: "guide" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: guidePage.title,
  component: GuideBody,
});

function GuideBody() {
  return (
    <WebsiteChrome pane={guidePane}>
      <GuideOpening />
      <WebsiteSoon />
      <WebsiteGuide.Section.Render />
    </WebsiteChrome>
  );
}
