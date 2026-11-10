import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "../core";
import { Website, WebsiteHeader } from "./slots";
import { WebsiteChrome } from "./components/website-chrome";

/**
 * The landing pane — the site's index at bare `/website`. `appIndex` marks it
 * as the app's index pane.
 *
 * It wears the shared site header (`actions: WebsiteHeader`) like every other
 * website pane: the homepage is where the reader arrives, so the wordmark and the
 * nav have to be there before anything else can send them somewhere. The header
 * is declared once, by this plugin, and borrowed by all four pages.
 *
 * The body is the landing page itself: every `Website.Section` contribution
 * rendered top-to-bottom — the hero, the live demo, the three layers, the story link, the contact band —
 * in the order authored in `config/apps/website/shell/section.jsonc`. That file,
 * not the plugin load order, is what fixes the page's reading order.
 */
export const landingPane = Pane.define({
  route: defineRoute({ id: "website-landing", segment: "" }),
  app: websiteApp,
  appIndex: true,
  actions: WebsiteHeader,
  component: LandingBody,
});

function LandingBody() {
  return (
    <WebsiteChrome pane={landingPane}>
      <Website.Section.Render />
    </WebsiteChrome>
  );
}
