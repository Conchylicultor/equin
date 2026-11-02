import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { videoBlock } from "../core";

export default {
  description:
    "Video block type: registers its `data` schema (attachment) at the server write boundary.",
  contributions: [Editor.BlockData(videoBlock)],
} satisfies ServerPluginDefinition;
