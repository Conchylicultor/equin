import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/**
 * Whether `header` (a delivery's `X-Hub-Signature-256`, `sha256=<hex>`) is the
 * HMAC-SHA256 of `body` — the raw bytes, exactly as received — keyed by
 * `secret`. Constant-time over the digest; a missing or malformed header is
 * never a match.
 */
export function signatureMatches(
  secret: string,
  body: Uint8Array,
  header: string | null,
): boolean {
  if (header === null || !header.startsWith(PREFIX)) return false;
  const given = Buffer.from(header.slice(PREFIX.length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The header GitHub would send for `body` under `secret` (tests, fixtures). */
export function signatureOf(secret: string, body: Uint8Array): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}
