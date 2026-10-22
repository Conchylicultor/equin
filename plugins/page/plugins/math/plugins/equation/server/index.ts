import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { equationBlock } from "../core";

export default {
  portable: true,
  description:
    "Block-level equation type: registers its `data` schema (LaTeX source) at the server write boundary.",
  contributions: [Editor.BlockData(equationBlock)],
} satisfies ServerPluginDefinition;
