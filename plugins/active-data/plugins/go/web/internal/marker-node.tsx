import { defineInlineTokenNode } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/core";
import { GoDraftRemove } from "../components/go-draft-remove";
import { GO_MARKER_TYPE } from "./go-regions";

/**
 * The two edges of a `<go>` region in a draft, as tokens: `<go>` and `</go>`
 * are atomic nodes (an invisible start mark, and the ✕ cap that closes the
 * region the way ▶ closes it in the reply) while the text
 * between them stays ordinary, editable text. The draft's markdown therefore
 * IS the text the agent receives — no serializer of its own — and the region
 * plugin (`go-region-plugin.tsx`) only paints what lies between.
 *
 * A `type` alias, never an `interface` — see `defineInlineTokenNode`.
 */
export type GoMarkerFields = { edge: "open" | "close" };

export const GO_MARKER_RE = /<\/?go>/g;

const goMarkerNode = defineInlineTokenNode<GoMarkerFields>({
  type: GO_MARKER_TYPE,
  fields: ["edge"],
  token: ({ edge }) => (edge === "open" ? "<go>" : "</go>"),
  fieldsOf: (match) => ({ edge: match[0] === "<go>" ? "open" : "close" }),
  // "token": a region copied out of the draft re-parses as a region.
  textContent: "token",
});

export const goMarkerWebNode = goMarkerNode.decorated({
  render: ({ edge }, node) =>
    edge === "close" ? <GoDraftRemove closeKey={node.getKey()} /> : null,
});
