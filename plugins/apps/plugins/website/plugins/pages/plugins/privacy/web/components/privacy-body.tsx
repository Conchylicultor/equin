import { WebsiteChrome } from "@plugins/apps/plugins/website/plugins/shell/web";
import { privacyPane } from "../panes";
import { PrivacyOpening } from "./privacy-opening";
import { PrivacyPolicy } from "./privacy-policy";

/**
 * The privacy page's body: the heading, then the policy inside
 * `WebsiteChrome`. Its own chunk (`websitePagePart`), fetched only where the
 * page is shown.
 */
export function PrivacyBody() {
  return (
    <WebsiteChrome pane={privacyPane}>
      <PrivacyOpening />
      <PrivacyPolicy />
    </WebsiteChrome>
  );
}
