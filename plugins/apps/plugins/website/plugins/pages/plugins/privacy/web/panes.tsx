import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import {
  WebsiteChrome,
  WebsiteHeader,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { privacyPage } from "../core";
import { PrivacyOpening } from "./components/privacy-opening";
import { PrivacyPolicy } from "./components/privacy-policy";

/**
 * The privacy page at `/about/privacy` — the "Privacy Policy" the consent
 * prompt links to, and the place a visitor changes their answer. Wears the
 * shared site header (`actions: WebsiteHeader`) without a link of its own in
 * it: it is reached from the footer's small print and from the prompt.
 */
export const privacyPane = Pane.define({
  route: defineRoute({ id: "website-privacy", segment: "privacy" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: privacyPage.title,
  component: PrivacyBody,
});

function PrivacyBody() {
  return (
    <WebsiteChrome pane={privacyPane}>
      <PrivacyOpening />
      <PrivacyPolicy />
    </WebsiteChrome>
  );
}
