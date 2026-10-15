import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";

/**
 * `css:no-unanchored-has` — a `:has()` must sit on a compound that names its
 * element: a type, a class, an id, an attribute, or `&` (a nested rule, named
 * by its parent).
 *
 * WHY. A browser matches right to left, so a compound with nothing but pseudo
 * classes — `:has(x)`, `:not(:has(x))` — is tried on EVERY element in its
 * scope, and every element becomes a `:has()` subject. From then on any DOM
 * insertion or removal anywhere invalidates each ancestor's whole subtree:
 * Chrome cannot tell which subject's answer changed. The wide-table rule in
 * `scroll.css` was shaped so (`[data-scroll-x-host]:has(…) :has(…)`), and a
 * click opening a transcript card restyled ~37k elements (0.3–0.7 s) before
 * the fold could start. Anchored, Chrome only re-checks the few elements the
 * anchor names.
 *
 * An anchor carries into `:not()` / `:is()` / `:where()` on the same element —
 * `.panel:not(:has(x))` is anchored — but not across a combinator, and never
 * out of a `:has()` argument (which names other elements).
 *
 * Scope: every `*.css` under `plugins/`. Tailwind's own `has-*` / `group-has-*`
 * variants always hang off a class, so they cannot produce the shape.
 */

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
    if (c === '"' || c === "'") quote = c;
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

/** One compound's top-level pieces: whether it names its element, and its
 *  functional pseudo-classes with their arguments. */
function readCompound(compound: string): {
  anchored: boolean;
  pseudos: { name: string; arg: string }[];
} {
  let anchored = false;
  const pseudos: { name: string; arg: string }[] = [];
  let i = 0;
  if (/^[a-zA-Z]/.test(compound)) anchored = true; // a type selector
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
        pseudos.push({ name: m[1]!, arg: compound.slice(i + 1, end - 1) });
        i = end;
      }
    } else if (c === "\\") i += 2;
    else i++;
  }
  return { anchored, pseudos };
}

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

const SAME_ELEMENT = new Set(["not", "is", "where", "matches"]);

/**
 * The compounds of a selector list that carry a `:has()` with nothing naming
 * their element. `inherited`: the list is the argument of a same-element
 * pseudo on an anchored compound, so its LAST compound is anchored by it.
 */
export function unanchoredHas(
  selectorList: string,
  inherited = false,
): string[] {
  const found: string[] = [];
  for (const complex of splitTop(selectorList, comma)) {
    const compounds = splitTop(complex, combinator);
    compounds.forEach((compound, idx) => {
      const own = readCompound(compound);
      const anchored =
        own.anchored || (inherited && idx === compounds.length - 1);
      for (const { name, arg } of own.pseudos) {
        if (name === "has" && !anchored) found.push(compound);
        if (SAME_ELEMENT.has(name)) found.push(...unanchoredHas(arg, anchored));
      }
    });
  }
  return found;
}

/** Every rule prelude (selector list) in a stylesheet, at-rules skipped. */
export function selectorPreludes(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const prelude = src.slice(start, i).trim();
      if (prelude && !prelude.startsWith("@")) out.push(prelude);
      start = i + 1;
    } else if (c === "}" || c === ";") start = i + 1;
  }
  return out;
}

const check: Check = {
  id: "css:no-unanchored-has",
  description:
    "a :has() must sit on a compound naming its element (type/class/id/attribute/&) — an unanchored one makes every element a :has() subject, so any DOM insertion restyles the whole subtree",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const offenders: string[] = [];
    for (const file of repo.under("plugins")) {
      if (!file.endsWith(".css")) continue;
      const css = await repo.read(file);
      if (css === null) throw new Error(`${file}: listed but unreadable`);
      for (const prelude of selectorPreludes(css))
        for (const compound of unanchoredHas(prelude))
          offenders.push(
            `${file}: \`${compound}\` in \`${prelude.replace(/\s+/g, " ")}\``,
          );
    }
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `unanchored :has() — every element becomes a subject, and any insertion restyles the whole subtree:\n${offenders.join("\n")}`,
      hint: "Anchor the compound (a class, an attribute, a type), or have the code that knows the elements mark them and key the rule on that mark (see css/plugins/scroll: useScrollsSideways).",
    };
  },
};

export default check;
