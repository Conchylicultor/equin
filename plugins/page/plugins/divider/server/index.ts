import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { dividerBlock } from "../core";

export default {
  description:
    "Divider block type: registers its (empty) `data` schema at the server write boundary, rejecting stray keys like injected text.",
  contributions: [Editor.BlockData(dividerBlock)],
} satisfies ServerPluginDefinition;
