import { scanHtml } from "@plugins/infra/plugins/html-decode/core";
import {
  foldOptions,
  type OptionSource,
  type PrototypeOption,
} from "./options";

/** A page's valid options and the problem detail of every line that is not one. */
export function readPrototypeOptions(html: string): {
  options: PrototypeOption[];
  problems: string[];
} {
  return foldOptions(readOptionSource(html));
}

/**
 * Everything a prototype's `index.html` declares about itself, read in ONE pass
 * of the scanner: the gallery list, the folder validator and the server's
 * stamping all read it through here, so none of them can disagree about what a
 * page declares — and a list of the tree tokenizes each entry file once, not
 * once per reader (it used to be four times: validation facts, validation
 * options, the meta, the meta's options — 70% of a cold list's CPU).
 *
 * Each `<title>` / `<meta>` value is the FIRST occurrence's, decoded once:
 * a `<title>` further down the document (inside an inline `<svg>`, say) is not
 * the document's title. `undefined` ⇔ absent.
 */
export interface PrototypeEntry {
  title: string | undefined;
  /** `<meta name="description">`. */
  description: string | undefined;
  /** `<meta name="prototype-viewport">`, unparsed (`parseViewport`). */
  viewport: string | undefined;
  /** `<meta name="mocks">`, unparsed (`parseMocks`). */
  mocks: string | undefined;
  /**
   * It loads a Babel-transformed script from a separate file — a validation
   * problem. `<script type="text/babel" src="app.jsx">` is the one violation
   * that LOOKS fine: it works through the server and silently renders nothing
   * over `file://` (Babel-standalone fetches a `src` with XHR, which Chrome
   * refuses file→file). A plain non-Babel `<script src>` is fine.
   */
  loadsExternalBabelScript: boolean;
  /** The option declarations, for `foldOptions`. */
  optionSource: OptionSource;
}

export function readPrototypeEntry(html: string): PrototypeEntry {
  let title: string | undefined;
  let description: string | undefined;
  let viewport: string | undefined;
  let mocks: string | undefined;
  let loadsExternalBabelScript = false;
  const declarations: string[] = [];
  const groups: { at: number; label: string }[] = [];
  const htmlData: Record<string, string> = {};
  let htmlVars: Record<string, string> = {};
  let sawHtml = false;

  scanHtml(html, {
    elements: {
      html(el) {
        // Only the document element: an inline `<svg>` cannot hold one, but a
        // second literal `<html>` in the source is not the page's root.
        if (sawHtml) return;
        sawHtml = true;
        for (const attr of el.attributeNames) {
          if (!attr.startsWith("data-")) continue;
          const value = el.attr(attr);
          if (value !== undefined) htmlData[attr.slice("data-".length)] = value;
        }
        const style = el.attr("style");
        if (style !== undefined) htmlVars = readCustomProperties(style);
      },
      meta(el) {
        const name = el.attr("name");
        if (name === "prototype-option-group") {
          groups.push({
            at: declarations.length,
            label: el.attr("content") ?? "",
          });
        } else if (name === "prototype-option") {
          declarations.push(el.attr("content") ?? "");
        } else if (name === "description") {
          description ??= el.attr("content");
        } else if (name === "prototype-viewport") {
          viewport ??= el.attr("content");
        } else if (name === "mocks") {
          mocks ??= el.attr("content");
        }
      },
      script(el) {
        if (el.attr("type")?.trim().toLowerCase() !== "text/babel") return;
        if (el.attr("src") !== undefined) loadsExternalBabelScript = true;
      },
    },
    text: {
      title(text) {
        title ??= text;
      },
    },
  });
  return {
    title,
    description,
    viewport,
    mocks,
    loadsExternalBabelScript,
    optionSource: { declarations, groups, htmlData, htmlVars },
  };
}

/**
 * Read the option declarations out of a prototype's HTML: every
 * `<meta name="prototype-option">` content, in document order, every
 * `<meta name="prototype-option-group">` and where it starts, the `data-*`
 * attributes on `<html>` (choice defaults) and the custom properties in its
 * `style` (color defaults) — the option half of {@link readPrototypeEntry}.
 */
export function readOptionSource(html: string): OptionSource {
  return readPrototypeEntry(html).optionSource;
}

/**
 * The custom properties of a `style` attribute, keyed WITHOUT the `--`:
 * `--accent: #7c5cff; color: red` → `{ accent: "#7c5cff" }`. Declarations are
 * split on the `;`s outside parentheses and quotes, so an `oklch(…)` or a
 * quoted font name never cuts one in two. A later declaration of the same
 * property wins, as in CSS.
 */
export function readCustomProperties(style: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const declaration of splitDeclarations(style)) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const prop = declaration.slice(0, colon).trim();
    if (!prop.startsWith("--")) continue;
    vars[prop.slice(2)] = declaration.slice(colon + 1).trim();
  }
  return vars;
}

/** A `style` attribute's declarations, split on top-level `;`. */
export function splitDeclarations(style: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < style.length; i++) {
    const ch = style[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(style.slice(start, i));
      start = i + 1;
    }
  }
  out.push(style.slice(start));
  return out.filter((d) => d.trim() !== "");
}
