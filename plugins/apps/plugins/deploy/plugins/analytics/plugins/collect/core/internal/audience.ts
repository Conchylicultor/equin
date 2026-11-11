import { z } from "zod";

/**
 * Whose visits a report or a visit list counts. The site's owner marks their
 * own devices (see {@link OWNER_MARK_FRAGMENT}); every visit from a marked
 * device is the owner's (`analytics_visits.owner`), so reading their own site
 * never inflates its numbers.
 *
 * - `visitors` — everyone but the owner: the default, and the only audience
 *   the stored daily totals hold (the rollup sums visitors only), so a range
 *   past the raw window can answer nothing else.
 * - `you` — the owner's own visits only.
 * - `all` — both.
 */
export const AUDIENCES = ["visitors", "you", "all"] as const;
export const AudienceSchema = z.enum(AUDIENCES);
export type Audience = z.infer<typeof AudienceSchema>;

/** Each audience in the dashboard's words. */
export const AUDIENCE_LABEL: Record<Audience, string> = {
  visitors: "Visitors",
  you: "You",
  all: "All",
};

/** The audience switch's options, in order. */
export const AUDIENCE_OPTIONS: readonly { id: Audience; label: string }[] =
  AUDIENCES.map((id) => ({ id, label: AUDIENCE_LABEL[id] }));

/** The audience a question that does not name one asks for. */
export const DEFAULT_AUDIENCE: Audience = "visitors";

/**
 * The URL fragment that marks the browser opening it as the owner's:
 * `https://<site>/#equin-me`. A fragment never reaches the server (nor its
 * logs). The mark is a flag in the site's local storage (the tracker's
 * `owner-mark.ts`), so it lasts until that browser's site data is cleared —
 * once per browser, laptop and phone alike.
 */
export const OWNER_MARK_FRAGMENT = "equin-me";
/** The fragment that removes the mark: `https://<site>/#equin-not-me`. */
export const OWNER_UNMARK_FRAGMENT = "equin-not-me";

/** The link that marks a device as the owner's on the site at `siteUrl` (an origin). */
export function ownerMarkUrl(siteUrl: string): string {
  return `${siteUrl}/#${OWNER_MARK_FRAGMENT}`;
}

/** The link that removes the mark on the site at `siteUrl` (an origin). */
export function ownerUnmarkUrl(siteUrl: string): string {
  return `${siteUrl}/#${OWNER_UNMARK_FRAGMENT}`;
}
