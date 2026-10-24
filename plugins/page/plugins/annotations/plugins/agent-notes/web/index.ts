import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { ContainerNoRow } from "@plugins/page/plugins/container/web";
import { agentNotesBlock } from "../core";
import { AgentNotesAnchor } from "./components/agent-notes-anchor";
import { AgentNotesFrame } from "./components/agent-notes-frame";

export { agentNotesBlock } from "../core";

export default {
  description:
    "Agent-notes block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, holding what an agent wrote back to the page's author.",
  contributions: [
    // The card renders NO row of its own — `BlockRow`'s anchored branch never
    // dispatches `Editor.Block` for an `anchor` type, so the container
    // primitive's shared null renderer is unreachable. The registration itself is
    // where the HANDLE lives, and the handle is what the insert palette, the
    // markdown pipeline, paste, the turn-into list and `useAnchorTypes()` (the
    // reducer's `anchorTypes`) all read.
    Editor.Block({
      id: agentNotesBlock.type,
      match: agentNotesBlock.type,
      block: agentNotesBlock,
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
      match: agentNotesBlock.type,
      component: AgentNotesFrame,
      cornerAnchor: AgentNotesAnchor,
      // A wash is a filled box: its content clears every edge.
      pad: "box",
    }),
  ],
} satisfies PluginDefinition;
