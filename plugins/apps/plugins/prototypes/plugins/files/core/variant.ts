import { isOptionName, isPickValue, type OptionPicks } from "./options";
import type { StoredPicks } from "./picks";

// A VARIANT — some option picks — named in text, in two spellings of one
// value:
//
// - **written** by an agent after a prototype id, the document URL's own query
//   (`proto-…?pane=floating&accent=#10b981`): what `prototype options` prints
//   and what an agent already knows, so a chip can point at one variant.
// - **addressed** by the canvas pane's `;variant=` URL key
//   (`proto/proto-…;variant=pane.floating~accent.%2310b981`): `.` and `~` are
//   left as they are by `encodeURIComponent` (`=` / `&` would be escaped), and
//   neither can occur in an option name or a pick value. Every pick spelled is
//   one that differs from the page's default (the writer resolves them first),
//   and an explicit "on the defaults" is `defaults` — a present key with no
//   pick, distinct from an absent key (the shared picks).

/** One `name=value` pair of the written query — a pick value, `#rrggbb` included. */
const QUERY_PAIR = "[a-z][a-z0-9-]*=(?:#[0-9a-fA-F]{6}|[a-z0-9][a-z0-9-]*)";

/**
 * The written variant after an id: `?name=value(&name=value)*`. Unanchored
 * and without flags, for a caller to compose its source into its own pattern
 * (the chip's).
 */
export const VARIANT_QUERY_PATTERN = new RegExp(
  `\\?${QUERY_PAIR}(?:&${QUERY_PAIR})*`,
);

/**
 * The picks a written variant names (`?pane=floating&accent=#10b981`), a hex
 * lowercased as stored; `v` (the document's cache-bust, never an option) is
 * left out. Grammar only — whether the prototype declares them is
 * the document's to judge (`resolvePicks`). Throws on text that is not one:
 * a caller hands it what {@link VARIANT_QUERY_PATTERN} matched.
 */
export function parseVariantQuery(query: string): StoredPicks {
  if (!new RegExp(`^${VARIANT_QUERY_PATTERN.source}$`).test(query)) {
    throw new Error(`not a written variant: ${JSON.stringify(query)}`);
  }
  const picks: Record<string, string> = {};
  for (const pair of query.slice(1).split("&")) {
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    if (!isOptionName(name)) continue;
    const value = pair.slice(eq + 1);
    picks[name] = value.startsWith("#") ? value.toLowerCase() : value;
  }
  return picks;
}

/** The `;variant=` value of a frame on its default for every option. */
const ON_DEFAULTS = "defaults";

/**
 * The pane's `;variant=` value for `picks` — resolved picks, so only what
 * differs from the defaults is spelled; `defaults` when nothing does.
 */
export function variantParam(picks: OptionPicks): string {
  const pairs = Object.entries(picks).map(([name, value]) => {
    if (!isOptionName(name) || !isPickValue(value)) {
      throw new Error(`not a pick: ${name}=${value}`);
    }
    return `${name}.${value}`;
  });
  return pairs.length === 0 ? ON_DEFAULTS : pairs.join("~");
}

/**
 * The picks a `;variant=` value names. The address bar is untrusted input:
 * a pair that is not a pick (a stale link, a hand edit) is dropped, never
 * thrown on, and the page then shows that option's default — as for an
 * absent pair.
 */
export function picksOfVariantParam(param: string): StoredPicks {
  const picks: Record<string, string> = {};
  if (param === ON_DEFAULTS) return picks;
  for (const pair of param.split("~")) {
    const dot = pair.indexOf(".");
    if (dot < 0) continue;
    const name = pair.slice(0, dot);
    const value = pair.slice(dot + 1);
    if (isOptionName(name) && isPickValue(value)) picks[name] = value;
  }
  return picks;
}
