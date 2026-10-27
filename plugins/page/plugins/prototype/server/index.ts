import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { prototypeBlock } from "../core";
import { resolvePrototypeTitles } from "./internal/annotations";

export default {
  description:
    "Prototype block type: registers its `data` schema (the prototype id) at the server write boundary, and supplies the prototype's `<title>` to the `<prototype>` tag an agent reads.",
  // Its one read (the title) goes through prototypes' portable `files` server,
  // so it runs wherever pages do — a browser host included.
  portable: true,
  contributions: [
    Editor.BlockData(prototypeBlock),
    // The read-only `title` on `<prototype id="…" title="…"/>`.
    Editor.BlockAnnotation({ resolve: resolvePrototypeTitles }),
  ],
} satisfies ServerPluginDefinition;
