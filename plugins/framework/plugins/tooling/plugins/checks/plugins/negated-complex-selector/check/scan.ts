/**
 * Finds `:not()` whose argument is a COMPLEX selector — one with a combinator
 * (descendant space, `>`, `+`, `~`) — directly or through `:is()` / `:where()`.
 *
 * Chrome cannot narrow such a negation to the rule's subject: a change to any
 * class or attribute named inside it (`:not(.boundary *)`,
 * `:not(:where([data-input-modality="pointer"] *))`) invalidates the style of
 * the whole subtree under the changed element. Flipping that state on a box
 * high up (`<html>`, an app container) restyles the entire document. The
 * positive ancestor form (`:where(:root:not([…])) .x`, `.boundary .x`) is
 * invalidated for the rule's subjects alone.
 *
 * `:has()` and `:nth-child(… of S)` arguments are not walked: neither is the
 * negated-complex shape.
 */

export interface ComplexNegation {
  /** Offset of the `:not(` in the scanned text. */
  index: number;
  /** The whole `:not(…)`, as written. */
  text: string;
}

/**
 * Index of the bracket closing the `(` or `[` at `open`, or -1; skips quoted
 * strings and backslash escapes, and nests the other bracket kind.
 */
function closeBracket(src: string, open: number): number {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") stack.push(")");
    else if (c === "[") stack.push("]");
    else if (c === ")" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Functional pseudo-classes whose argument is matched against the subject itself. */
const TRANSPARENT = new Set(["is", "where", "matches", "any", "-webkit-any"]);

/** Whether `sel` (a selector list) holds a combinator at its top level, or inside `:is` / `:where`. */
export function hasCombinator(sel: string): boolean {
  let quote: string | null = null;
  let bracket = 0;
  // Whether a compound has started since the last comma or combinator.
  let inCompound = false;
  let pendingSpace = false;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (bracket > 0) {
      if (c === '"' || c === "'") quote = c;
      else if (c === "[") bracket++;
      else if (c === "]") bracket--;
      continue;
    }
    if (c === "\\") {
      i++;
      inCompound = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (inCompound) pendingSpace = true;
      continue;
    }
    if (c === ",") {
      inCompound = false;
      pendingSpace = false;
      continue;
    }
    if (c === ">" || c === "+" || c === "~") return true;
    // A new compound after whitespace that followed one: a descendant combinator.
    if (pendingSpace) return true;
    if (c === "[") {
      bracket = 1;
      inCompound = true;
      continue;
    }
    if (c === "(") {
      const name = /([\w-]+)$/.exec(sel.slice(0, i))?.[1] ?? "";
      const close = closeBracket(sel, i);
      if (close < 0) return false;
      if (TRANSPARENT.has(name) && hasCombinator(sel.slice(i + 1, close)))
        return true;
      i = close;
      inCompound = true;
      continue;
    }
    inCompound = true;
  }
  return false;
}

/**
 * Every complex `:not()` in `src`. `underscoreIsSpace` reads Tailwind's
 * arbitrary-variant spelling, where `_` stands for a space (`\_` is a literal
 * underscore).
 */
export function complexNegations(
  src: string,
  { underscoreIsSpace }: { underscoreIsSpace: boolean },
): ComplexNegation[] {
  const out: ComplexNegation[] = [];
  for (const m of src.matchAll(/:not\(/g)) {
    const open = m.index + ":not".length;
    const close = closeBracket(src, open);
    if (close < 0) continue;
    let arg = src.slice(open + 1, close);
    if (underscoreIsSpace) arg = arg.replace(/(?<!\\)_/g, " ");
    if (hasCombinator(arg))
      out.push({ index: m.index, text: src.slice(m.index, close + 1) });
  }
  return out;
}

/**
 * Every Tailwind arbitrary variant in `src` — a balanced `[…]` followed by `:`
 * (`[&:not(.x_*)]:`, `group-[…]:`, `has-[…]:`, stacked ones each on its own) —
 * with its offset. Tailwind's `not-[S]:` variant emits `:not(S)`, so it is
 * returned spelled that way.
 */
export function arbitraryVariants(
  src: string,
): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  for (const m of src.matchAll(/(\bnot-)?\[/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeBracket(src, open);
    if (close < 0 || src[close + 1] !== ":") continue;
    const body = src.slice(open + 1, close);
    out.push({
      index: m.index,
      text:
        m[1] === undefined ? src.slice(m.index, close + 2) : `:not(${body})`,
    });
  }
  return out;
}
