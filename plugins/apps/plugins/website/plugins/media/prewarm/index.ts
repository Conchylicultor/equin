import { defineAssetMirrorPrewarm } from "@plugins/infra/plugins/asset-mirror/core";
import { websiteMediaSource } from "../core";

/**
 * Prewarm seed for the website's media: a release bundles every file the site
 * shows (every file the mirror pins), so a deployed site serves the film from
 * its first visitor on — never a download from GitHub on that visitor's
 * first click.
 */
export default defineAssetMirrorPrewarm({ source: websiteMediaSource });
