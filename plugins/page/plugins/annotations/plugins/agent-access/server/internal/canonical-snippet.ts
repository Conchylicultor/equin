import {
  parseInlineMarkdown,
  serializeInlineMarkdown,
} from "@plugins/page/plugins/editor/core";

/**
 * `edit_page`'s `old_string`, spelled the way `read_page` would spell it.
 *
 * `read_page` emits CANONICAL inline markdown: every literal delimiter
 * backslash-escaped (`~20` reads `\~20`, `snake_case` reads `snake\_case`), and
 * a mark split around a protected span (`**Run (task-…).**` reads
 * `**Run (**task-…**).**`, because an id chip carries no mark). An agent that
 * edits text it WROTE itself copies it from its own earlier `new_string`, not
 * from a read — and that spelling is not the page's, so a plain match missed it
 * every time, with an error blaming the agent's memory.
 *
 * So each line's inline text goes through the same parse → serialize pair the
 * page's own text goes through on a read (`serializeInlineMarkdown` is what the
 * serializer renders a block's text with). For text the read emitted the pair
 * is the identity — that is its round-trip contract — so only a non-canonical
 * spelling changes, and it changes into the one the read holds.
 *
 * Per LINE, not per document: an `old_string` is a fragment (it may open or end
 * mid-line, or open a tag it does not close), which the block parser cannot be
 * handed. What the line-level pass leaves alone is the block syntax that is not
 * inline text: the indentation and list / to-do / heading / quote marker in
 * front of it, a tag line, and a fenced body, which is verbatim.
 */
export function canonicalSnippet(
  snippet: string,
  protectedSpans: RegExp[],
): string {
  let inFence = false;
  return snippet
    .split("\n")
    .map((line) => {
      const fence = FENCE.test(line);
      if (inFence || fence) {
        if (fence) inFence = !inFence;
        return line;
      }
      const [, prefix = "", text = ""] = BLOCK_PREFIX.exec(line)!;
      if (text === "" || text.startsWith("<")) return line;
      return (
        prefix +
        serializeInlineMarkdown(
          parseInlineMarkdown(text, protectedSpans),
          protectedSpans,
          "escaped",
        )
      );
    })
    .join("\n");
}

/** A fence's open / close line: ```` ``` ```` (code) or `$$` (equation). */
const FENCE = /^[ \t]*(?:```|\$\$)/;

/**
 * The block syntax in front of a line's inline text: indentation, then at most
 * one list marker (`*`, `-`, `+`, `1.`), to-do box, heading or quote marker.
 */
const BLOCK_PREFIX =
  /^([ \t]*(?:(?:[*+-]|\d+\.) (?:\[[ xX]\] )?|#{1,6} |> )?)(.*)$/;
