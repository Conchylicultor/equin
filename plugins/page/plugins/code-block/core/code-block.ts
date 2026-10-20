import { z } from "zod";
import { defineBlock } from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const codeIcon = symbol("code");

export const CODE_BLOCK_VIEWS = ["code", "preview", "split"] as const;
export type CodeBlockView = (typeof CODE_BLOCK_VIEWS)[number];

export const codeBlock = defineBlock({
  type: "code-block",
  schema: z.object({
    code: z.string().default(""),
    // A shiki language id (see SHIKI_LANGS); undefined renders as plain text.
    language: z.string().optional(),
    // How a language with a code preview (a mermaid diagram) shows: its source,
    // its preview, or both. Display state only — not part of the markdown fence.
    // undefined ⇒ split. Ignored for a language with no preview.
    view: z.enum(CODE_BLOCK_VIEWS).optional(),
  }),
  label: "Code",
  icon: codeIcon,
  aliases: ["snippet", "syntax", "monospace", "pre"],
  empty: () => ({ code: "" }),
  // Fenced markdown: ```lang\n…code…\n``` round-trips code + language. The info
  // string after the opening fence is the shiki language id (empty ⇒ plain text).
  markdown: {
    fence: {
      open: "```",
      close: "```",
      parseFenced: (info, body) => ({
        code: body,
        ...(info ? { language: info } : {}),
      }),
    },
    serialize: (d) => "```" + (d.language ?? "") + "\n" + d.code + "\n```",
  },
  // Typing ``` at the start of a text block converts it into a code block. The
  // generic MarkdownShortcutPlugin reads this off the slot — no editor changes.
  // TYPING-only: the markdown side of ``` is the `fence` above (a multi-line
  // region, not a line prefix), so this never feeds the clipboard pipeline.
  typingPrefixes: ["```"],
  // Not a doc-text block: the code sits at `Inset y="xs"` + the `<pre>`'s `p-md`,
  // on a fixed `leading-5` (1.25rem) line — so seat the rail on that first line.
  gutterFirstLineCenter: "calc(var(--space-xs) + var(--space-md) + 0.625rem)",
});
