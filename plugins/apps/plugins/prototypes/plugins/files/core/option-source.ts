import { readHtmlAttr } from "@plugins/infra/plugins/html-decode/core";
import {
  foldOptions,
  type OptionSource,
  type PrototypeOption,
} from "./options";

/** A page's valid options and the problem detail of every line that is not one. */
export async function readPrototypeOptions(
  html: string,
): Promise<{ options: PrototypeOption[]; problems: string[] }> {
  return foldOptions(await readOptionSource(html));
}

/**
 * Read the option declarations out of a prototype's HTML: every
 * `<meta name="prototype-option">` content, in document order, every
 * `<meta name="prototype-option-group">` and where it starts, the `data-*`
 * attributes on `<html>` (choice defaults) and the custom properties in its
 * `style` (color defaults). The ONE read — the gallery list, the
 * folder validator and the server's stamping all go through it, so none of them
 * can disagree about what a page declares.
 *
 * Decoded exactly once via `html-decode`, like every HTMLRewriter read.
 */
export async function readOptionSource(html: string): Promise<OptionSource> {
  const declarations: string[] = [];
  const groups: { at: number; label: string }[] = [];
  const htmlData: Record<string, string> = {};
  let htmlVars: Record<string, string> = {};
  let sawHtml = false;

  const rewriter = new HTMLRewriter()
    .on("html", {
      element(el) {
        // Only the document element: an inline `<svg>` cannot hold one, but a
        // second literal `<html>` in the source is not the page's root.
        if (sawHtml) return;
        sawHtml = true;
        for (const [attr] of el.attributes) {
          if (!attr.startsWith("data-")) continue;
          const value = readHtmlAttr(el, attr);
          if (value !== undefined) htmlData[attr.slice("data-".length)] = value;
        }
        const style = readHtmlAttr(el, "style");
        if (style !== undefined) htmlVars = readCustomProperties(style);
      },
    })
    .on("meta", {
      element(el) {
        const name = readHtmlAttr(el, "name");
        if (name === "prototype-option-group") {
          groups.push({
            at: declarations.length,
            label: readHtmlAttr(el, "content") ?? "",
          });
        } else if (name === "prototype-option") {
          declarations.push(readHtmlAttr(el, "content") ?? "");
        }
      },
    });

  // The rewriter only runs its handlers as the body is consumed.
  await rewriter.transform(new Response(html)).text();
  return { declarations, groups, htmlData, htmlVars };
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
