import { rewriteStartTag } from "@plugins/infra/plugins/html-decode/core";
import { splitDeclarations } from "./option-source";
import { pickedColor, type OptionPicks, type PrototypeOption } from "./options";

/**
 * `html` with `picks` (already judged against `options`) stamped onto its
 * first `<html>`, overwriting the defaults the author wrote there: a choice as
 * `data-<option>="<value>"`, a color as `--<option>: #rrggbb` in its `style`.
 * Spliced in place by `html-decode`, so every other byte of the page — the
 * rest of the `<html>` tag included — is served as written. A page with no
 * `<html>` tag is served unchanged: there is nothing to stamp onto.
 *
 * The one HTML REWRITE of a served document — every other read only extracts.
 * Pure, so a served page's stamp is the same on every host.
 */
export function stampPicks(
  html: string,
  options: readonly PrototypeOption[],
  picks: OptionPicks,
): string {
  const stamped = rewriteStartTag(html, "html", (el) => {
    // Names and values are already validated against the declaration, which
    // only admits [a-z0-9-] and `#rrggbb`; the rewrite escapes regardless.
    const colors: [string, string][] = [];
    for (const option of options) {
      if (!(option.name in picks)) continue;
      if (option.kind === "choice") {
        el.setAttribute(`data-${option.name}`, picks[option.name]!);
      } else {
        colors.push([option.name, pickedColor(option, picks)]);
      }
    }
    if (colors.length > 0) {
      // Edited decoded — a raw `&quot;` holds a `;` that is not a
      // declaration's end — and written back through `setAttribute`, which
      // escapes it again.
      el.setAttribute(
        "style",
        withCustomProperties(el.attr("style") ?? "", colors),
      );
    }
  });
  return stamped.kind === "edited" ? stamped.html : html;
}

/**
 * `style` with each `--<name>: <value>` of `vars` set: every existing
 * declaration of those properties is dropped and the new ones are appended,
 * so the stamped value is the one in force. Every other declaration is kept
 * as written.
 */
export function withCustomProperties(
  style: string,
  vars: readonly (readonly [string, string])[],
): string {
  const names = new Set(vars.map(([name]) => name));
  const kept = splitDeclarations(style)
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const colon = declaration.indexOf(":");
      const prop = colon < 0 ? "" : declaration.slice(0, colon).trim();
      return !(prop.startsWith("--") && names.has(prop.slice(2)));
    });
  return [...kept, ...vars.map(([name, value]) => `--${name}: ${value}`)].join(
    "; ",
  );
}
