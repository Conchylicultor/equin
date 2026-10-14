import type { LexicalNode, NodeKey } from "lexical";
import type { InlineTokenNode } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import { inlineChipNode, type InlineChipFields } from "../../core";
import { renderInlineChip } from "./render-inline-chip";
import { TokenFrame } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/web";

/**
 * The browser half: the SAME family declared in `core/node.ts`, with the chip
 * rendering added. Extending the core spec rather than re-declaring one is what
 * makes the browser's class and the server's the same token type by
 * construction — see that module for why the declaration lives there.
 *
 * Exported from the barrel because a second Lexical host (active-data's
 * page-editor bridge) registers this same node with its own extension shape.
 */
export const inlineChipWebNode: InlineTokenNode<InlineChipFields> =
  inlineChipNode.decorated({
    className: "inline-flex align-middle mx-0.5",
    render: ({ text }, node) => (
      <InlineChipDecoration text={text} nodeKey={node.getKey()} />
    ),
  });

/** The Lexical class to register in an editor's `nodes` config. */
export const InlineChipNode = inlineChipWebNode.Node;

// Renders the chip that owns this token, through the one registry read that
// also applies the boundary (`renderInlineChip`). An unclaimed token stays raw
// text — which is what lets a document holding this node hydrate correctly in a
// composition without the owning chip plugin.
//
// Only ever rendered from `decorate()`, i.e. inside a `LexicalComposer`, so it
// can read the editor context. `TokenFrame` gives it the editing chrome every
// decorated token wears (selected whole, a hover-revealed ×) — every inline chip
// gets it with zero per-chip wiring. Read surfaces render the chip directly (via
// linkify/segments), never through this node, so they never get the ×.
function InlineChipDecoration({
  text,
  nodeKey,
}: {
  text: string;
  nodeKey: NodeKey;
}) {
  const chip = renderInlineChip(text);
  if (chip === null) return <>{text}</>;
  return (
    <TokenFrame nodeKey={nodeKey} removeLabel="Remove">
      {chip}
    </TokenFrame>
  );
}

export function $createInlineChipNode(text: string): LexicalNode {
  return inlineChipWebNode.create({ text });
}
