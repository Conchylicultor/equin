import { MAX_REFERRER_LENGTH, MAX_UTM_LENGTH, type UtmTags } from "../../core";
import { canParseUrl } from "@plugins/packages/plugins/floor-compat/core";

/**
 * Where the visitor came from, read once from the page load's landing URL and
 * `document.referrer`. Sent with the first pageview only: a later in-app
 * navigation has no referrer of its own, and re-sending the landing one would
 * credit every page to the site that linked the first.
 */
export interface LandingSource {
  /** An external referrer URL, or undefined for none / a same-site one. */
  referrer?: string;
  utm?: UtmTags;
}

/**
 * `document.referrer` only when it names ANOTHER site. A same-site referrer is
 * the visitor reloading or arriving from one of our own pages, which is not a
 * source. An unparseable or oversized value is dropped rather than sent.
 */
export function externalReferrer(
  referrer: string,
  siteHost: string,
): string | undefined {
  if (referrer === "" || referrer.length > MAX_REFERRER_LENGTH)
    return undefined;
  if (!canParseUrl(referrer)) return undefined;
  const url = new URL(referrer);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.host.toLowerCase() === siteHost.toLowerCase()
    ? undefined
    : referrer;
}

const UTM_KEYS = ["source", "medium", "campaign"] as const;

/** The `utm_source` / `utm_medium` / `utm_campaign` tags on the landing URL. */
export function utmTags(search: string): UtmTags | undefined {
  const params = new URLSearchParams(search);
  const tags: UtmTags = {};
  for (const key of UTM_KEYS) {
    const value = params.get(`utm_${key}`)?.trim();
    if (value) tags[key] = value.slice(0, MAX_UTM_LENGTH);
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

export function landingSource(opts: {
  referrer: string;
  search: string;
  siteHost: string;
}): LandingSource {
  const referrer = externalReferrer(opts.referrer, opts.siteHost);
  const utm = utmTags(opts.search);
  return {
    ...(referrer !== undefined ? { referrer } : {}),
    ...(utm !== undefined ? { utm } : {}),
  };
}
