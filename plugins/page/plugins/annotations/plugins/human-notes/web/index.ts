import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { ContainerNoRow } from "@plugins/page/plugins/container/web";
import { humanNotesBlock } from "../core";
import { HumanNotesAnchor } from "./components/human-notes-anchor";
import { HumanNotesFrame } from "./components/human-notes-frame";

export { humanNotesBlock } from "../core";

export default {
  description:
    "Human block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, holding the page author's own words addressed to agents rather than to the reader — and, being the author's, the one an agent may read but never write.",
  contributions: [
    // The card renders NO row of its own — `BlockRow`'s anchored branch never
    // dispatches `Editor.Block` for an `anchor` type, so the container
    // primitive's shared null renderer is unreachable. The registration itself is
    // where the HANDLE lives, and the handle is what the insert palette, the
    // markdown pipeline, paste, the turn-into list and `useAnchorTypes()` (the
    // reducer's `anchorTypes`) all read.
    //
    // The id is the block's TYPE, which is why the type is still `context` after
    // the rename: reorder's persisted per-slot directives are keyed by
    // contribution id, so a new id would silently discard whatever ordering and
    // visibility a user had configured for this card.
    Editor.Block({
      id: humanNotesBlock.type,
      match: humanNotesBlock.type,
      block: humanNotesBlock,
      component: ContainerNoRow,
    }),
    // Contributing a frame is what MAKES this a container: the framed-type set is
    // derived from this slot's registered matches (`useIsFramedBlock()`), so
    // there is no second "I am a container" flag to drift from who actually
    // paints a box. the DECORATION rides on the SAME registration, so the handle's
    // `anchor: true` cannot claim one that nothing supplies. This family asks for
    // the CORNER seat — the card's own name, revealed only while the pointer is
    // inside its box — where the callout asks for the gutter glyph.
    // (`./equin check page-editor:anchor-has-decoration`).
    Editor.BlockFrame({
      match: humanNotesBlock.type,
      component: HumanNotesFrame,
      cornerAnchor: HumanNotesAnchor,
      // A wash is a filled box: its content clears every edge.
      pad: "box",
    }),
  ],
} satisfies PluginDefinition;
