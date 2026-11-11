import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { downloadPage } from "../core";
import {
  WebsiteChrome,
  WebsiteHeader,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { DownloadOpening } from "./components/download-opening";
import { DownloadInstall } from "./components/download-install";

/**
 * The download page at `/about/download` — how to get equin running on your
 * own machine. Wears the shared site header (`actions: WebsiteHeader`); the
 * heading, then the one install band inside `WebsiteChrome`.
 */
export const downloadPane = Pane.define({
  route: defineRoute({ id: "website-download", segment: "download" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: downloadPage.title,
  component: DownloadBody,
});

function DownloadBody() {
  return (
    <WebsiteChrome pane={downloadPane}>
      <DownloadOpening />
      <DownloadInstall />
    </WebsiteChrome>
  );
}
