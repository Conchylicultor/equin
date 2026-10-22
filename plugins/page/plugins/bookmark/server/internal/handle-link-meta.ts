import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { SsrfError } from "@plugins/infra/plugins/safe-fetch/server";
import { linkMetaEndpoint } from "../../core";
import { PageFetchError, scrapeLinkMeta } from "./scrape";

export const handleLinkMeta = implement(linkMetaEndpoint, async ({ query }) => {
  try {
    const { title } = await scrapeLinkMeta(query.url);
    return { title };
  } catch (err) {
    if (err instanceof SsrfError) throw new HttpError(400, err.message);
    if (err instanceof PageFetchError) throw new HttpError(502, err.message);
    throw err;
  }
});
