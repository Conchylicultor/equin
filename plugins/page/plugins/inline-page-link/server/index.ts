import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { PageLinks } from "@plugins/page/plugins/links/server";
import { _blocks, Editor } from "@plugins/page/plugins/editor/server";
import { InlineTokenReferentSource } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { PAGE_LINK_TOKEN_PATTERN, pageLinkInlineNode } from "../core";
import { extractInlinePageLinks } from "./internal/extract-inline-links";
import { resolvePageLinkReferent } from "./internal/referent";

export default {
  portable: true,
  description:
    "Backlinks extractor for inline `[[page:<pageId>]]` page links embedded in any block's text.",
  contributions: [
    // Global extractor (no `type`): runs on every block so inline links in any
    // text-bearing block type feed the backlinks index without enumerating types.
    PageLinks.Extractor({ extract: extractInlinePageLinks }),
    // The same pattern the web extension deserializes with, so server-side
    // markdown serialization leaves `[[page:<pageId>]]` bytes alone. One
    // RegExp, and its alternation already covers the pre-namespace form — the
    // slot takes a pattern, never a capture group, so nothing here branches.
    //
    // `node` is the SAME spec object `web/components/page-link-inline-node.tsx`
    // decorates, so a block holding a materialized page link stays readable and
    // editable from the server instead of refusing every `edit_page`.
    Editor.InlineToken({
      pattern: PAGE_LINK_TOKEN_PATTERN,
      // `[[page:<id>]]` is made of brackets, which the inline scan reads as a
      // markdown link — so it genuinely needs masking. `markdownSpan` is a
      // separate field from `pattern` because most tokens do NOT.
      markdownSpan: "protect",
      node: pageLinkInlineNode,
    }),
    // What the token names, read on the server: the linked page's title. Text a
    // model reads gets `<page id title/>` for it, and text a person reads (a
    // backlink's snippet) gets the title the chip shows — instead of the raw
    // `[[page:<id>]]` bytes, or the bare-block-id family reading the id INSIDE
    // them (this span starts first, so it wins the overlap).
    InlineTokenReferentSource({
      kind: "page",
      pattern: PAGE_LINK_TOKEN_PATTERN,
      tables: [_blocks],
      resolve: resolvePageLinkReferent,
    }),
  ],
} satisfies ServerPluginDefinition;
