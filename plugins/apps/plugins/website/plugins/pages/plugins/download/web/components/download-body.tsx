import { WebsiteChrome } from "@plugins/apps/plugins/website/plugins/shell/web";
import { downloadPane } from "../panes";
import { DownloadOpening } from "./download-opening";
import { DownloadInstall } from "./download-install";

/**
 * The download page's body: the heading, then the one install band inside
 * `WebsiteChrome`. Its own chunk (`websitePagePart`), fetched only where the
 * page is shown.
 */
export function DownloadBody() {
  return (
    <WebsiteChrome pane={downloadPane}>
      <DownloadOpening />
      <DownloadInstall />
    </WebsiteChrome>
  );
}
