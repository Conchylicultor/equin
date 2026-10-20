import { plainOf } from "@plugins/page/plugins/editor/core";
import type {
  InsertAction,
  InsertActionRun,
} from "@plugins/page/plugins/editor/web";
import { codeBlock } from "@plugins/page/plugins/code-block/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

function useMermaidInsertRun(): InsertActionRun {
  return ({ editor, text }) => {
    // The line's other words become the diagram's first line, so nothing the
    // user typed disappears.
    editor.convertTo(
      codeBlock.type,
      codeBlock.schema.parse({
        code: plainOf(text).trim(),
        language: "mermaid",
        view: "split",
      }),
    );
  };
}

/**
 * `/mermaid`: a code block preset to mermaid, listed right after Code. An insert
 * action because a block type's menu entry always starts from its `empty()` data
 * — it cannot preset a language.
 */
export const mermaidInsertAction: InsertAction = {
  id: "mermaid",
  label: "Mermaid diagram",
  icon: symbol("account-tree"),
  aliases: ["diagram", "flowchart", "sequence diagram", "graph", "chart"],
  after: codeBlock.type,
  useRun: useMermaidInsertRun,
};
