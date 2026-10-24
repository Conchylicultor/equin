import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { ContainerNoRow } from "@plugins/page/plugins/container/web";
import { quoteBlock } from "../core";
import { QuoteAnchor } from "./components/quote-anchor";
import { QuoteFrame } from "./components/quote-frame";

export { quoteBlock } from "../core";

export default {
  description:
    "Quote block type: a void CONTAINER whose left bar spans blocks of any type nested inside it, so a quotation may be a passage — several paragraphs, a list, a heading — rather than one line.",
  contributions: [
    // The quote renders NO row of its own — `BlockRow`'s anchored branch never
    // dispatches `Editor.Block` for an `anchor` type, so the container
    // primitive's shared null renderer is unreachable. The registration itself is
    // where the HANDLE lives, and the handle is what the insert palette, the
    // markdown pipeline, paste, the turn-into list, `useAnchorTypes()` (the
    // reducer's `anchorTypes`) and the markdown-shortcut plugin (this block's
    // `| ` prefix) all read.
    Editor.Block({
      id: quoteBlock.type,
      match: quoteBlock.type,
      block: quoteBlock,
      component: ContainerNoRow,
    }),
    // Contributing a frame is what MAKES this a container: the framed-type set is
    // derived from this slot's registered matches (`useIsFramedBlock()`), so
    // there is no second "I am a container" flag to drift from who actually
    // paints a box. `anchor` rides on the SAME registration, so the handle's
    // `anchor: true` cannot claim a decoration that nothing supplies
    // (`./equin check page-editor:anchor-has-decoration`). No `menu`: a
    // quote has no per-instance appearance to reach from the rail.
    Editor.BlockFrame({
      match: quoteBlock.type,
      component: QuoteFrame,
      anchor: QuoteAnchor,
      // A rule, not a box: the bar has no right or top edge for text to land
      // on, so padding it would only narrow the passage and stretch the bar
      // past the lines it marks. The gap between bar and first letter is the
      // children's own `BLOCK_INDENT`.
      pad: "rule",
    }),
  ],
} satisfies PluginDefinition;
