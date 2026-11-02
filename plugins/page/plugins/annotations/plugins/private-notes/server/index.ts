import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { privateNotesBlock } from "../core";

export default {
  description:
    "Private-note block type: registers its (empty) `data` schema at the server write boundary, rejecting stray keys like an injected `text`.",
  contributions: [Editor.BlockData(privateNotesBlock)],
} satisfies ServerPluginDefinition;
