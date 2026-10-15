/**
 * The one definition of a `:has()` that restyles whole subtrees — read by the
 * `css:no-unanchored-has` check (stylesheets) and the
 * `layout/no-unanchored-has` lint rule (Tailwind variants, translated to the
 * selector they compile to).
 *
 * THE INVARIANT. In a complex selector, the compound carrying a `:has()` and
 * every compound after it must name their element: a type, a class, an id, an
 * attribute, or `&`.
 *
 * WHY. A browser matches right to left, and Chrome invalidates `:has()` by the
 * features of the elements it may affect. A `:has()` on a compound with
 * nothing but pseudo classes (`:has(x)`, `:not(:has(x))`) makes EVERY element
 * in its scope a subject; a compound after a `:has()` that names nothing
 * (`.a:has(x) *`, `.a:has(x) > :first-child`) makes every descendant of each
 * `:has()` element possibly changed. Either way, any DOM insertion or removal
 * restyles whole subtrees: a transcript card's click restyled ~37k elements
 * (0.3–0.7 s, `scroll.css`), and Tailwind's `group-has-*` cost ~7 s of style
 * recalc over twelve map zoom steps (`map/google/e2e/zoom-profile.ts`).
 *
 * ANCHORS. A compound is anchored by its own type/class/id/attribute/`&`, or
 * by an `:is()` / `:where()` whose every alternative ends in an anchored
 * compound (`:where(.group)`). `:not()` never anchors (it matches nearly
 * everything). An anchor carries into the LAST compound of a same-element
 * pseudo's argument (`.panel:not(:has(x))`, `.a:is(.b :has(x))`), never across
 * a combinator and never out of a `:has()` argument (which names other
 * elements). A `:has()` nested in a same-element pseudo makes its compound a
 * `:has()` carrier for what follows (`:where(.g):not(:has(x)) *`), but a
 * compound that follows a `:has()` INSIDE an argument needs its own anchor —
 * Chrome does not borrow the outer compound's (`.cls:is(.g:has(x) *)`, which
 * is what `group-has-*` compiles to, is the measured case).
 */

/** An offending compound: the one carrying the `:has()`, or one after it. */
export type UnanchoredHas = { compound: string; at: "has" | "after-has" };

/** Top-level splits of `s` where `isSep` reports a separator's length
 *  (outside (), [] and quotes). */
function splitTop(
  s: string,
  isSep: (s: string, i: number) => number,
): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") i++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0) {
      const len = isSep(s, i);
      if (len > 0) {
        out.push(s.slice(start, i));
        start = i + len;
        i += len - 1;
      }
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

const comma = (s: string, i: number) => (s[i] === "," ? 1 : 0);
/** A combinator: whitespace and/or one of `>`, `+`, `~` between compounds. */
const combinator = (s: string, i: number) => {
  let j = i;
  while (j < s.length && /[\s>+~]/.test(s[j]!)) j++;
  return j > i ? j - i : 0;
};

/** Index just past the group opening at `i` (nesting-aware). */
function skipGroup(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
  }
  return s.length;
}

/** Pseudos whose argument describes the SAME element. */
const SAME_ELEMENT = new Set(["not", "is", "where", "matches"]);
/** Same-element pseudos that also anchor it (`:not` matches the rest). */
const ANCHORING = new Set(["is", "where", "matches"]);

/** One compound's top-level pieces: whether it names its element, and its
 *  functional pseudo-classes with their arguments. */
function readCompound(compound: string): {
  anchored: boolean;
  pseudos: { name: string; arg: string }[];
} {
  let anchored = /^[a-zA-Z]/.test(compound); // a type selector
  const pseudos: { name: string; arg: string }[] = [];
  let i = 0;
  while (i < compound.length) {
    const c = compound[i]!;
    if (c === "." || c === "#" || c === "&") {
      anchored = true;
      i++;
    } else if (c === "[") {
      anchored = true;
      i = skipGroup(compound, i, "[", "]");
    } else if (c === ":") {
      const m = /^::?([a-zA-Z-]+)/.exec(compound.slice(i));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      if (compound[i] === "(") {
        const end = skipGroup(compound, i, "(", ")");
        const pseudo = { name: m[1]!, arg: compound.slice(i + 1, end - 1) };
        pseudos.push(pseudo);
        if (ANCHORING.has(pseudo.name) && endsAnchored(pseudo.arg))
          anchored = true;
        i = end;
      }
    } else if (c === "\\") i += 2;
    else i++;
  }
  return { anchored, pseudos };
}

/** Every alternative of the list ends in a compound naming its element. */
function endsAnchored(selectorList: string): boolean {
  const alternatives = splitTop(selectorList, comma);
  return (
    alternatives.length > 0 &&
    alternatives.every((complex) => {
      const last = splitTop(complex, combinator).at(-1);
      return last !== undefined && readCompound(last).anchored;
    })
  );
}

/**
 * `inherited`: the list is the argument of a same-element pseudo on an
 * anchored compound, so its LAST compound is anchored by it.
 */
function scan(
  selectorList: string,
  inherited: boolean,
): { found: UnanchoredHas[]; carriesHas: boolean } {
  const found: UnanchoredHas[] = [];
  let carriesHas = false;
  for (const complex of splitTop(selectorList, comma)) {
    const compounds = splitTop(complex, combinator);
    let afterHas = false;
    compounds.forEach((compound, idx) => {
      const own = readCompound(compound);
      const anchored =
        own.anchored || (inherited && idx === compounds.length - 1);
      if (afterHas && !own.anchored) found.push({ compound, at: "after-has" });
      let carries = false;
      for (const { name, arg } of own.pseudos) {
        if (name === "has") {
          carries = true;
          if (!anchored && !afterHas) found.push({ compound, at: "has" });
        } else if (SAME_ELEMENT.has(name)) {
          const inner = scan(arg, anchored);
          found.push(...inner.found);
          carries ||= inner.carriesHas;
        }
      }
      if (carries) afterHas = carriesHas = true;
    });
  }
  return { found, carriesHas };
}

/** The compounds of a selector list breaking the invariant above. */
export function unanchoredHas(selectorList: string): UnanchoredHas[] {
  return scan(selectorList, false).found;
}
