import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { calloutBlock } from "../core";
import { blocksByTypeServed } from "./internal/saved-icons";

export default {
  description:
    "Callout block type: registers its `data` schema (icon + semantic color) at the server write boundary, and serves page.blocks-by-type — the live blocks of one type, which the callouts' saved-icon source follows at type = callout.",
  contributions: [
    Editor.BlockData(calloutBlock),
    ...blocksByTypeServed.declare,
  ],
} satisfies ServerPluginDefinition;
