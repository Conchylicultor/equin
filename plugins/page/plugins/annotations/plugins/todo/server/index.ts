import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { todoBlock } from "../core";

export default {
  description:
    "TODO block type: registers its (empty) `data` schema at the server write boundary, rejecting stray keys like an injected `text`.",
  contributions: [Editor.BlockData(todoBlock)],
} satisfies ServerPluginDefinition;
