import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { toggleBlock } from "../core";

export default {
  description:
    "Toggle (collapsible) block type: registers its `data` schema at the server write boundary.",
  contributions: [Editor.BlockData(toggleBlock)],
} satisfies ServerPluginDefinition;
