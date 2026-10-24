import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { ContainerNoRow } from "@plugins/page/plugins/container/web";
import { privateNotesBlock } from "../core";
import { PrivateNotesAnchor } from "./components/private-notes-anchor";
import { PrivateNotesFrame } from "./components/private-notes-frame";

export { privateNotesBlock } from "../core";

export default {
  description:
    "Private-note block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, holding notes withheld from agents.",
  contributions: [
    // The card renders NO row of its own — `BlockRow`'s anchored branch never
    // dispatches `Editor.Block` for an `anchor` type, so the container
    // primitive's shared null renderer is unreachable. The registration itself is
    // where the HANDLE lives, and the handle is what the insert palette, the
    // markdown pipeline, paste, the turn-into list and `useAnchorTypes()` (the
    // reducer's `anchorTypes`) all read.
    Editor.Block({
      id: privateNotesBlock.type,
      match: privateNotesBlock.type,
      block: privateNotesBlock,
      component: ContainerNoRow,
    }),
    // Contributing a frame is what MAKES this a container: the framed-type set is
    // derived from this slot's registered matches (`useIsFramedBlock()`), so
    // there is no second "I am a container" flag to drift from who actually
    // paints a box. `anchor` rides on the SAME registration
    // (`./equin check page-editor:anchor-has-decoration`).
    Editor.BlockFrame({
      match: privateNotesBlock.type,
      component: PrivateNotesFrame,
      cornerAnchor: PrivateNotesAnchor,
      // A wash is a filled box: its content clears every edge.
      pad: "box",
    }),
  ],
} satisfies PluginDefinition;
