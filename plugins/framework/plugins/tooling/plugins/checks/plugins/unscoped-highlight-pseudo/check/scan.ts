/**
 * Finds the `::highlight(name)` rules whose originating element is any
 * element: the pseudo-element written with nothing before it (`::highlight(x)`,
 * also after a combinator or a comma — `.a ::highlight(x)`) or after a bare
 * universal selector (`*::highlight(x)`).
 */

export interface UnscopedHighlight {
  /** Index of the `::highlight(` in the scanned text. */
  index: number;
  /** The selector, from its compound's start to the pseudo-element's close. */
  text: string;
}

const HIGHLIGHT = "::highlight(";

/** Characters that end a compound selector, read right to left. */
const BOUNDARY = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  ",",
  ">",
  "+",
  "~",
  "{",
  "}",
  ";",
]);

const CLOSE_OF: Record<string, string> = { ")": "(", "]": "[" };

/** The compound selector written right before `index` (empty when none). */
export function compoundBefore(src: string, index: number): string {
  let i = index;
  const stack: string[] = [];
  while (i > 0) {
    const ch = src[i - 1]!;
    if (stack.length > 0) {
      if (ch === stack.at(-1)) stack.pop();
      else if (CLOSE_OF[ch]) stack.push(CLOSE_OF[ch]!);
      i--;
      continue;
    }
    if (CLOSE_OF[ch]) {
      stack.push(CLOSE_OF[ch]!);
      i--;
      continue;
    }
    if (BOUNDARY.has(ch)) break;
    i--;
  }
  return src.slice(i, index);
}

export function unscopedHighlights(src: string): UnscopedHighlight[] {
  const out: UnscopedHighlight[] = [];
  for (
    let at = src.indexOf(HIGHLIGHT);
    at !== -1;
    at = src.indexOf(HIGHLIGHT, at + HIGHLIGHT.length)
  ) {
    const compound = compoundBefore(src, at);
    if (compound !== "" && compound !== "*") continue;
    const close = src.indexOf(")", at);
    out.push({
      index: at - compound.length,
      text: src.slice(
        at - compound.length,
        close === -1 ? undefined : close + 1,
      ),
    });
  }
  return out;
}
