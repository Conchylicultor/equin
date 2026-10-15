import {
  blockTextTokenExtension,
  registerBlockTextExtension,
} from "@plugins/page/plugins/editor/web";
import { PAGE_LINK_TOKEN_PATTERN } from "../../core";
import { pageLinkInlineWebNode } from "../components/page-link-inline-node";
import { InlinePageLinkPlugin } from "../components/inline-page-link-plugin";
import { PageLinkChip } from "../components/page-link-chip";
import { BlockIdPastePlugin } from "../components/block-id-paste-plugin";

// Side-effect: teach every block text editor about inline page links — the node
// (whose token format and fields are declared once in `core/node.ts`, so the
// serializer and the parser cannot disagree), the `[[page:<pageId>]]` pattern,
// the `[[` typeahead plugin, and how the token paints on a surface that mounts
// no Lexical (page history, diffs, the public site).
registerBlockTextExtension(
  blockTextTokenExtension({
    id: "page-link-inline",
    node: pageLinkInlineWebNode,
    pattern: PAGE_LINK_TOKEN_PATTERN,
    // `[[page:<id>]]` is made of brackets, which the inline scan reads as a
    // markdown link — so its bytes must be masked out of that scan.
    markdownSpan: "protect",
    renderToken: ({ pageId }) => <PageLinkChip pageId={pageId} />,
    Plugin: InlinePageLinkPlugin,
  }),
);

// Side-effect: a pasted bare block id becomes a page reference — the empty
// block turns into a page-link block, otherwise an inline chip at the caret.
registerBlockTextExtension({
  id: "page-id-paste",
  Plugin: BlockIdPastePlugin,
});
