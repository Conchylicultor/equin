import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { heading2Block } from "../core";

export default {
  description:
    "Heading 2 block type: registers its `data` schema at the server write boundary.",
  contributions: [Editor.BlockData(heading2Block)],
} satisfies ServerPluginDefinition;
