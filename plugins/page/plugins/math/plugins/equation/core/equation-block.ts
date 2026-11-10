import { z } from "zod";
import { defineBlock } from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const functionsIcon = symbol("functions");

export const EQUATION_TYPE = "equation";

export const equationBlock = defineBlock({
  type: EQUATION_TYPE,
  schema: z.object({ expression: z.string().default("") }),
  label: "Equation",
  icon: functionsIcon,
  aliases: ["math", "latex", "katex", "formula", "tex", "equation"],
  empty: () => ({ expression: "" }),
  // Markdown: `$$expr`. Reads/writes `expression` (NOT `text`) — the source of the
  // former copy-as-empty-`$$` bug, where generic code read `d.text`.
  markdown: {
    serialize: (d) => "$$" + d.expression,
    parseLine: {
      claims: ["$$x"],
      parse: (line) =>
        line.startsWith("$$") ? { expression: line.slice(2).trim() } : null,
    },
  },
  // Typing `$$` at the start of a text block converts it into an equation block.
  // The generic MarkdownShortcutPlugin reads this off the slot — no editor changes.
  // TYPING-only: the `markdown` declaration above already owns `$$` on both
  // sides of the clipboard pipeline, and it reads `expression`, not `text`.
  typingPrefixes: ["$$"],
  // A line converted into an equation keeps its words as the LaTeX source.
  absorbText: (text) => ({ expression: text }),
});
