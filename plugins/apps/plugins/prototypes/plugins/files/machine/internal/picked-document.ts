import {
  pickedColor,
  picksFromQuery,
  readPrototypeOptions,
  type OptionPicks,
  type PrototypeOption,
} from "../../core";
import { readHtmlAttr } from "@plugins/infra/plugins/html-decode/core";
import { splitDeclarations } from "../../core/option-source";

// Option picks on a served document — shared by the live file route and the
// version file route, so a past version is switchable exactly like the live
// page, judged against its OWN declaration.

/** Does the query carry anything besides the `v` cache-bust? */
export function hasPicks(search: URLSearchParams): boolean {
  for (const key of search.keys()) if (key !== "v") return true;
  return false;
}

/**
 * The prototype's document with the picked option values stamped onto its
 * `<html>`, overwriting the defaults the author wrote there: a choice as
 * `data-<option>="<value>"`, a color as `--<option>: #rrggbb` in its `style`.
 * Nothing else in the page changes, so the page needs no code of its own to
 * be switchable: its CSS keys on `:root[data-<option>=…]` and reads
 * `var(--<option>)`, its JS reads `document.documentElement.dataset`.
 *
 * The text is read whole first because `<html>` streams before the `<meta>`
 * tags that say which picks are valid (prototype HTML is small). The picks are
 * judged against THIS document's declaration — for a recorded version, the
 * options it declared, not today's. A pick the page does not declare is a 400,
 * rendered inside the frame: a broken link must say so rather than show the
 * default and let the reader believe they are looking at the variant they
 * asked for.
 *
 * The one HTMLRewriter REWRITE in the repo — every other use only extracts.
 */
export async function servePickedDocument(
  html: string,
  search: URLSearchParams,
  headers: Record<string, string>,
): Promise<Response> {
  const { options } = await readPrototypeOptions(html);
  const result = picksFromQuery(options, search);
  if (!result.ok) {
    return new Response(
      `Cannot show this prototype variant: ${result.reason}.`,
      {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
  return new Response(await stampPicks(html, options, result.picks), {
    headers,
  });
}

/**
 * `html` with `picks` (already judged against `options`) stamped onto its
 * first `<html>`. Exported for its unit test.
 */
export async function stampPicks(
  html: string,
  options: readonly PrototypeOption[],
  picks: OptionPicks,
): Promise<string> {
  let stamped = false;
  const rewriter = new HTMLRewriter().on("html", {
    element(el) {
      if (stamped) return;
      stamped = true;
      // Names and values are already validated against the declaration, which
      // only admits [a-z0-9-] and `#rrggbb` — nothing here can break out of
      // the attribute.
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
          withCustomProperties(readHtmlAttr(el, "style") ?? "", colors),
        );
      }
    },
  });
  return rewriter.transform(new Response(html)).text();
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
