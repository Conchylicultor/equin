import type { LexicalNode } from "lexical";
import { TokenFrame } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/web";
import { pageLinkInlineNode } from "../../core";
import { PageLinkChip } from "./page-link-chip";

/**
 * The browser half of the inline page-link token: the SAME family declared in
 * `core/node.ts`, with rendering added. Everything structural — the type string,
 * the `__pageId` property, the token format, the empty `getTextContent()` — is
 * inherited from that one declaration.
 *
 * The chip wears `TokenFrame`, the editing chrome every other decorated token
 * (an inline id chip, a pasted image) wears: a selection that spans it rings
 * the chip as ONE object instead of highlighting its label's characters, and a
 * hover-revealed × removes it.
 */
export const pageLinkInlineWebNode = pageLinkInlineNode.decorated({
  className: "inline-flex align-baseline",
  render: ({ pageId }, node) => (
    <TokenFrame nodeKey={node.getKey()} removeLabel="Remove page link">
      <PageLinkChip pageId={pageId} />
    </TokenFrame>
  ),
});

/** The Lexical class to register in a block editor's `nodes` config. */
export const PageLinkInlineNode = pageLinkInlineWebNode.Node;

export function $createPageLinkInlineNode(pageId: string): LexicalNode {
  return pageLinkInlineWebNode.create({ pageId });
}
