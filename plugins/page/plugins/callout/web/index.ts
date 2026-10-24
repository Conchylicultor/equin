import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { ContainerNoRow } from "@plugins/page/plugins/container/web";
import { calloutBlock } from "../core";
import { CalloutAnchor } from "./components/callout-anchor";
import { CalloutMenu } from "./components/callout-menu";
import { CalloutFrame } from "./components/callout-frame";

export { calloutBlock } from "../core";

export default {
  description:
    "Callout block type: a void CONTAINER whose tinted box wraps blocks of any type nested inside it, with a changeable leading icon and semantic color, for notes/tips/warnings.",
  contributions: [
    // The callout renders NO row of its own — `BlockRow`'s anchored branch never
    // dispatches `Editor.Block` for an `anchor` type, so the container
    // primitive's shared null renderer is unreachable. The registration itself is
    // NOT vestigial: it is where the handle lives, and the handle is what the
    // insert palette, the markdown pipeline, paste, the turn-into list and
    // `useAnchorTypes()` (the reducer's `anchorTypes`) all read. The row's paint
    // comes from the frame's `anchor` below.
    Editor.Block({
      id: calloutBlock.type,
      match: calloutBlock.type,
      block: calloutBlock,
      component: ContainerNoRow,
    }),
    // Contributing a frame is what makes the callout a container: the surfaces
    // derive the framed-type set from this slot, group the callout's visible
    // subtree, and hand it here as children. `anchor` rides on the SAME
    // registration so a type cannot claim anchorhood without actually painting a
    // box (`./equin check page-editor:anchor-has-decoration`), and `menu`
    // rides on it for the same reason: the container's two surfaces (its glyph
    // and the rail popover on its borrowed line) cannot drift from who paints
    // the box. Both render the SAME appearance controls, deliberately — the
    // structural half of that popover (Collapse / Remove callout / Delete) is
    // generic and contributed by nobody.
    Editor.BlockFrame({
      match: calloutBlock.type,
      component: CalloutFrame,
      anchor: CalloutAnchor,
      // A filled box, so its content clears every edge — text sitting on a
      // tint's own boundary reads as a clipping bug.
      pad: "box",
      menu: CalloutMenu,
    }),
  ],
} satisfies PluginDefinition;
