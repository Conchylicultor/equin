import { serveValue } from "@plugins/network/plugins/live/server";
import { SsrfError } from "@plugins/infra/plugins/safe-fetch/server";
import { linkPreview } from "../../core";
import { PageFetchError, scrapeLinkPreview } from "./scrape";

/**
 * The link preview, scraped on a reader's ask. Each scrape caches the og:image
 * and favicon as fresh attachments (a DB write, never a read), which the block
 * links when it copies the answer into its data; an answer nobody copies is
 * reclaimed by the orphan sweep.
 */
export const linkPreviewServed = serveValue(linkPreview, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a third-party page's preview scraped for one url: no change signal, and the block copies the answer into its data and stops reading",
    },
  },
  loader: async ({ url }) => {
    try {
      return await scrapeLinkPreview(url);
    } catch (err) {
      if (err instanceof SsrfError)
        throw linkPreview.refuse("blocked", err.message);
      if (err instanceof PageFetchError) {
        throw linkPreview.refuse("unreachable", err.message);
      }
      throw err;
    }
  },
});
