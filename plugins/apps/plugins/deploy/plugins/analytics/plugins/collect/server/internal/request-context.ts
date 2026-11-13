import { createHash } from "node:crypto";
import { normalizeHost } from "../../core";

/**
 * The primary language subtag of an `Accept-Language` header (`fr-CH, fr;q=0.9`
 * → `fr`), or null when absent or not a language tag. Only the first entry:
 * it is the browser's own preference order.
 */
export function primaryLanguage(header: string | null): string | null {
  if (header === null) return null;
  const first = header.split(",")[0]?.split(";")[0]?.trim() ?? "";
  const primary = first.split("-")[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/**
 * The part of an IP address that names the visitor's network: an IPv4
 * address whole (an IPv4-mapped IPv6 address counts as its IPv4), an IPv6
 * address cut to its /64 prefix (`2001:db8:a:b::/64`).
 *
 * The cut is what lets the daily hash recognise a phone: the second half of an
 * IPv6 address is the device's own, and phones rotate it every few hours for
 * privacy (RFC 8981 temporary addresses), while the /64 stays the same for as
 * long as they stay on one network — a home's wifi. One /64 is one household,
 * as one public IPv4 address already is behind a home router.
 *
 * Throws on a value that is not an IP address: the gateway's forwarded hop
 * always is one, so anything else is a broken assumption, not a visitor.
 */
export function identityNetwork(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!bare.includes(":")) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bare))
      throw new Error(`analytics: ${JSON.stringify(ip)} is not an IP address`);
    return bare;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped?.[1] !== undefined) return mapped[1];
  const halves = bare.toLowerCase().split("::");
  const groups = (part: string | undefined) =>
    part === undefined || part === "" ? [] : part.split(":");
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  const valid =
    halves.length <= 2 &&
    (halves.length === 2 ? missing >= 1 : missing === 0) &&
    [...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/.test(g));
  if (!valid)
    throw new Error(`analytics: ${JSON.stringify(ip)} is not an IP address`);
  const full = [...head, ...Array<string>(missing).fill("0"), ...tail];
  const prefix = full.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}

/**
 * The daily visitor hash: the visitor's network ({@link identityNetwork}),
 * browser and site under that day's salt. The IP and user agent go in and are
 * never stored; the salt is deleted after its day, so the hash cannot be
 * recomputed later.
 */
export function visitorHash(parts: {
  salt: string;
  ip: string;
  userAgent: string;
  host: string;
}): string {
  return createHash("sha256")
    .update(
      [parts.salt, identityNetwork(parts.ip), parts.userAgent, parts.host].join(
        "\n",
      ),
    )
    .digest("hex");
}

/**
 * What is stored of a browser's consent key: its sha256 with the site's host,
 * so the key itself (which the browser sends on every hit) is never on disk.
 */
export function consentKeyHash(parts: { key: string; host: string }): string {
  return createHash("sha256")
    .update([parts.key, parts.host].join("\n"))
    .digest("hex");
}

/** Where a visit came from, as stored: host and path, never the query string. */
export interface ParsedReferrer {
  host: string;
  path: string;
}

/**
 * The referrer's host (normalised) and path. A self-referral — the site linking
 * to itself, e.g. after a reload — is no referrer at all. A value that is not an
 * absolute URL is dropped: `document.referrer` is either one or empty.
 */
export function parseReferrer(
  referrer: string | undefined,
  siteHost: string,
): ParsedReferrer | null {
  if (!referrer) return null;
  if (!URL.canParse(referrer)) return null;
  const url = new URL(referrer);
  if (!url.hostname) return null;
  const host = normalizeHost(url.hostname);
  if (host === normalizeHost(siteHost.replace(/:\d+$/, ""))) return null;
  return { host, path: url.pathname || "/" };
}
