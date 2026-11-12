import type * as ScriptStateCore from "../core";

/**
 * Source scanning for `script-state:no-stylesheet-reads`: the attributes the
 * repo declares script-only (`defineScriptState("data-…")`), and every
 * stylesheet selector that names one.
 */

/** The declaring call, tied to the export by tsc so a rename cannot orphan the scan. */
const DECLARE: keyof typeof ScriptStateCore = "defineScriptState";

export interface Hit {
  /** Offset in the scanned text. */
  index: number;
  text: string;
}

export type Declaration =
  | { ok: true; index: number; attribute: string }
  | { ok: false; index: number; text: string };

/** Whether the line holding `index` is a comment line (`//`, `/*`, ` * `). */
export function onCommentLine(src: string, index: number): boolean {
  const start = src.lastIndexOf("\n", index) + 1;
  return /^\s*(\/\/|\/\*|\*)/.test(src.slice(start, index));
}

/** Blank CSS comments, keeping newlines so line numbers still point at the source. */
export function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/**
 * Every `defineScriptState(…)` call in `src` (the definition itself and
 * comment lines aside). A call whose attribute is not a string literal is
 * returned as not ok: the check cannot know what it declares.
 */
export function declarations(src: string): Declaration[] {
  const out: Declaration[] = [];
  for (const m of src.matchAll(new RegExp(`\\b${DECLARE}\\(`, "g"))) {
    if (onCommentLine(src, m.index)) continue;
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index)))
      continue;
    const rest = src.slice(m.index + m[0].length);
    const lit = /^\s*(["'`])(data-[\w-]+)\1\s*[,)]/.exec(rest);
    if (lit !== null)
      out.push({ ok: true, index: m.index, attribute: lit[2]! });
    else
      out.push({
        ok: false,
        index: m.index,
        text: src.slice(m.index, m.index + m[0].length + 40).split("\n")[0]!,
      });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every place `src` selects on `attribute` in what becomes a stylesheet:
 *
 * - `css`: any attribute selector naming it (`[data-x]`, `[data-x="y"] .z`,
 *   inside `:not()` / `:where()` / `:has()` alike);
 * - everywhere: the Tailwind variants that compile to one — an arbitrary
 *   variant (`[[data-x=y]_&]:p-2`, `[&:not([data-x]_*)]:p-2`), the data
 *   variant (`data-[x=y]:`, `in-data-[x=y]:`, `group-data-[x]:`) and v4's
 *   shorthand (`data-x:`, `in-data-x:`). Comment lines are skipped in script.
 *
 * A selector handed to `querySelector` / `matches` costs no restyle and is
 * not matched (it is not followed by a variant's `]:`).
 */
export function stylesheetReads(
  src: string,
  attribute: string,
  { css }: { css: boolean },
): Hit[] {
  const attr = escapeRe(attribute);
  const name = escapeRe(attribute.slice("data-".length));
  const patterns = [
    // An arbitrary variant: a class token opening its own `[` (a selector
    // string's first `[` IS the attribute, so `'[data-x]:not(.y)'` is not
    // one), the attribute selector inside it, then the variant's `]:`.
    new RegExp(
      `(?<=^|[\\s"'\`])[\\w-]*\\[\\S*?\\[${attr}(?![\\w-])\\S*?\\]:`,
      "g",
    ),
    // The data variant, under any prefix (group-, peer-, in-, not-, has-).
    new RegExp(`(?<![\\w])data-\\[${name}(?![\\w-])[^\\]\\s]*\\]:`, "g"),
    // v4's shorthand data variant.
    new RegExp(`(?<![\\w])data-${name}:`, "g"),
  ];
  if (css) patterns.push(new RegExp(`\\[\\s*${attr}(?![\\w-])`, "g"));
  const hits = new Map<number, Hit>();
  for (const re of patterns)
    for (const m of src.matchAll(re)) {
      if (!css && onCommentLine(src, m.index)) continue;
      if (!hits.has(m.index)) hits.set(m.index, { index: m.index, text: m[0] });
    }
  return [...hits.values()].sort((a, b) => a.index - b.index);
}
