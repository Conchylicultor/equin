import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { mermaidInsertAction } from "./internal/mermaid-insert-action";

export default {
  description:
    "`/mermaid` in the page editor: turns the caret's line into a code block set to mermaid, shown split — its source above the drawn diagram (the code-preview registry draws it).",
  contributions: [Editor.InsertAction(mermaidInsertAction)],
} satisfies PluginDefinition;
