import { landingPane } from "@plugins/apps/plugins/website/plugins/shell/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";

/** The homepage. */
export function landingUrl(): string {
  return landingPane.link(websiteApp, {});
}
