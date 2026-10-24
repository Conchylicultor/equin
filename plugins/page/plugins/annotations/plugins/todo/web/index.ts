import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { ContainerNoRow } from "@plugins/page/plugins/container/web";
import { todoBlock } from "../core";
import { TodoAnchor } from "./components/todo-anchor";
import { TodoFoot } from "./components/todo-foot";
import { TodoFrame } from "./components/todo-frame";
import { TodoMenu } from "./components/todo-menu";

export { todoBlock } from "../core";

export default {
  description:
    "TODO block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, marking a region of work agents still have to do. Also minted by typing `TODO ` at the start of a line. Its corner name and its rail menu open the dispatch panel, its box follows the dispatched task's live status, and its foot carries a chip per run the card has launched.",
  contributions: [
    // The card renders NO row of its own — `BlockRow`'s anchored branch never
    // dispatches `Editor.Block` for an `anchor` type, so the container
    // primitive's shared null renderer is unreachable. The registration itself is
    // where the HANDLE lives, and the handle is what the insert palette, the
    // markdown pipeline, paste, the turn-into list, `useAnchorTypes()` and the
    // markdown-shortcut plugin (this block's `TODO ` prefix) all read.
    Editor.Block({
      id: todoBlock.type,
      match: todoBlock.type,
      block: todoBlock,
      component: ContainerNoRow,
    }),
    // Contributing a frame is what MAKES this a container: the framed-type set is
    // derived from this slot's registered matches (`useIsFramedBlock()`), so
    // there is no second "I am a container" flag to drift from who actually
    // paints a box. `anchor` rides on the SAME registration
    // (`./equin check page-editor:anchor-has-decoration`).
    // `menu` rides on the SAME registration for the same reason `anchor` does:
    // the card's two surfaces (its glyph, and the rail popover on the line it
    // borrows) cannot drift from who paints the box. Both render the SAME
    // dispatch panel, deliberately — the rail is where a user looks for a
    // block's actions, the glyph is where they look for the glyph. The
    // structural half of that popover (Collapse / Remove TODO / Delete) stays
    // generic and is contributed by nobody.
    Editor.BlockFrame({
      match: todoBlock.type,
      component: TodoFrame,
      cornerAnchor: TodoAnchor,
      // A wash is a filled box: its content clears every edge.
      pad: "box",
      menu: TodoMenu,
      // The one container in the repo that declares a FOOT, and the reason the
      // seam exists: a dispatched card has something to say that is neither its
      // identity (the corner name) nor its contents (its children) — the runs it
      // started — and a decoration seat cannot carry it, because both seats float
      // over the content and reserve no space. The foot is the strip the box
      // makes room for. It stays empty, and costs the card no height at all,
      // until an agent is dispatched.
      foot: TodoFoot,
    }),
  ],
} satisfies PluginDefinition;
