import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  SsrfError,
  isUnreachableError,
} from "@plugins/infra/plugins/safe-fetch/server";
import { linkMeta } from "../../core";
import { PageFetchError, scrapeLinkMeta } from "./scrape";

/** A page's title, scraped on a reader's ask (no image is downloaded). */
export const linkMetaServed = serveValue(linkMeta, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a third-party page's title scraped for one url: no change signal, and the one reader (the pasted-link Mention) asks once and retitles the link",
    },
  },
  loader: async ({ url }) => {
    try {
      const { title } = await scrapeLinkMeta(url);
      return { title };
    } catch (err) {
      if (err instanceof SsrfError)
        throw linkMeta.refuse("blocked", err.message);
      // A dead or slow link — a non-2xx reply, a name that does not resolve,
      // a refused connection, a timeout — is an expected answer about the
      // user's link, never an app defect to report.
      if (err instanceof PageFetchError || isUnreachableError(err))
        throw linkMeta.refuse(
          "unreachable",
          err instanceof Error ? err.message : String(err),
        );
      throw err;
    }
  },
});
