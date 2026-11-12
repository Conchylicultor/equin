import type { PageLinkExtractor } from "@plugins/page/plugins/links/server";
import { pageLinkBlock } from "../../core";

// The backlinks extractor of the link-to-page block: its target page id, if
// any. Its own module, because it is part of the code the stored backlinks
// were derived by (`PageLinkExtractor.code`).
export const pageLinkExtractor: PageLinkExtractor = {
  type: pageLinkBlock.type,
  // Defensive parse — `data` is raw jsonb. Yield the target page id (if any).
  extract: (data) => {
    const r = pageLinkBlock.safeParse(data);
    return r.success && r.data.pageId ? [r.data.pageId] : [];
  },
  code: import.meta,
};
