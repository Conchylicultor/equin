import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

// Link-extractor registry (collection-consumer separation). Plugins contribute
// `PageLinks.Extractor({ type, extract })`; the reindexer dispatches generically
// and NEVER names a block type. `extract(data)` returns the target document ids
// this block links to.
//
// Two flavors:
//   - typed:  `type` set → runs only on blocks of that exact type (e.g. the
//             page-link block).
//   - global: `type` omitted → runs on EVERY block. Used for links that can live
//             inside any block's content (e.g. inline `[[…]]` tokens in text),
//             so contributors never have to enumerate the text-bearing types.
export interface PageLinkExtractor {
  type?: string;
  extract: (data: unknown) => string[];
  /**
   * The module holding `extract` (`import.meta`) — part of the code the
   * stored `page_links` rows were derived by. The boot backfill re-derives
   * every page's links only when that code changes (its source digest), so
   * keep the extractor in a small module: everything it loads counts.
   */
  code: ImportMeta;
}

export const PageLinks = {
  Extractor: defineServerContribution<PageLinkExtractor>("page.links.extractor", {
    docLabel: (props) => props.type ?? "* (all blocks)",
  }),
};
