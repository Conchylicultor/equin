import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { heading3Block } from "../core";

export default {
  description:
    "Heading 3 block type: registers its `data` schema at the server write boundary.",
  contributions: [Editor.BlockData(heading3Block)],
} satisfies ServerPluginDefinition;
