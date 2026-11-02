import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { calloutBlock } from "../core";
// Registers the callouts' saved-icon source (module eval).
import "./internal/saved-icons";

export default {
  description:
    "Callout block type: registers its `data` schema (icon + semantic color) at the server write boundary.",
  contributions: [Editor.BlockData(calloutBlock)],
} satisfies ServerPluginDefinition;
