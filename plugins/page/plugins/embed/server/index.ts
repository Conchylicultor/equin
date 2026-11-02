import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { embedBlock } from "../core";

export default {
  description:
    "Embed block type: registers its `data` schema (external URL) at the server write boundary.",
  contributions: [Editor.BlockData(embedBlock)],
} satisfies ServerPluginDefinition;
