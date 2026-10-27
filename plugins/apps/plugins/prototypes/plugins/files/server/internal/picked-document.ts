import { picksFromQuery, readPrototypeOptions } from "../../core";
import { stampPicks } from "../../core/stamp-picks";

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
 * The stamp itself is `stampPicks` (`core/stamp-picks.ts`).
 */
export function servePickedDocument(
  html: string,
  search: URLSearchParams,
  headers: Record<string, string>,
): Response {
  const { options } = readPrototypeOptions(html);
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
  return new Response(stampPicks(html, options, result.picks), {
    headers,
  });
}
