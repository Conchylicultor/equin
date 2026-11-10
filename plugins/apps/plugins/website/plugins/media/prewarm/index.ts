import { defineAssetMirrorPrewarm } from "@plugins/infra/plugins/asset-mirror/core";
import {
  WEBSITE_MEDIA_FILES,
  WEBSITE_MEDIA_MIRROR_ID,
  WEBSITE_MEDIA_REMOTE_BASE,
} from "../core";

/**
 * Prewarm seed for the website's media: a release bundles every file the site
 * shows, so a deployed site serves the film from its first visitor on — never
 * a download from GitHub on that visitor's first click.
 */
export default defineAssetMirrorPrewarm({
  id: WEBSITE_MEDIA_MIRROR_ID,
  remoteBaseUrl: WEBSITE_MEDIA_REMOTE_BASE,
  files: WEBSITE_MEDIA_FILES,
});
