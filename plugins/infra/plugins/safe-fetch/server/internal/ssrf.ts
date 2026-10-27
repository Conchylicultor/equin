/**
 * SSRF-guarded fetch primitive. Both the in-app browser proxy and the bookmark
 * scraper need to fetch arbitrary user-supplied URLs without letting a crafted
 * (or redirecting) target reach loopback / private-network / cloud-metadata
 * services. This module centralizes IP classification, URL parsing, DNS
 * resolution checks, and a redirect-following fetch that re-guards every hop.
 *
 * DNS-rebinding TOCTOU is closed by **IP pinning**: `assertResolvesPublic`
 * resolves + validates the hostname once and returns the validated IP, and
 * `safeFetch` then dials that exact IP (not the hostname), so `fetch`'s own
 * resolver never runs a second, unguarded lookup. The hostname is preserved for
 * SNI, the `Host` header, and TLS certificate verification via Bun fetch's
 * `tls.serverName` option, so vhost routing and cert identity stay correct while
 * the connection is bound to the address we security-checked.
 */
import { lookup } from "node:dns/promises";

/** Thrown when a URL is disallowed (bad scheme, or resolves to a non-public IP). */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Thrown by {@link safeFetch} when a target redirects more than `maxRedirects` times. */
export class TooManyRedirectsError extends Error {
  constructor(maxRedirects: number) {
    super(`Too many redirects (>${maxRedirects})`);
    this.name = "TooManyRedirectsError";
  }
}

/**
 * The error codes of a target that cannot be reached: `node:dns`'s for a name
 * with no usable answer, and the socket ones Bun's fetch puts on the
 * `TypeError` it throws for a failed dial (`ECONNREFUSED`, `ENOTFOUND`, …).
 */
const UNREACHABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_FAIL",
  "ENODATA",
  "ESERVFAIL",
  "ETIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Whether `err` — thrown by {@link safeFetch} — says the target could not be
 * reached, an ordinary answer about the URL rather than a bug: its name did not
 * resolve or the dial failed (an error carrying one of the network codes —
 * Bun's fetch throws a `TypeError` with `code: "ECONNREFUSED"` /
 * `"ENOTFOUND"`), the request timed out or was aborted (`TimeoutError` /
 * `AbortError`), or it redirected too often ({@link TooManyRedirectsError}). A
 * code-less `TypeError` is a programming error and does NOT count. A blocked
 * target is an {@link SsrfError}, classified apart; anything else — rethrow it.
 */
export function isUnreachableError(err: unknown): boolean {
  if (err instanceof TooManyRedirectsError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && UNREACHABLE_CODES.has(code);
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 8;

export interface SafeFetchInit {
  headers?: Record<string, string>;
  /** HTTP method (default GET). */
  method?: string;
  /**
   * Request body for non-GET methods (raw bytes / stream).
   *
   * `Bun.BodyInit`, NOT the bare global `BodyInit` — deliberately. The bare name
   * exists only in `lib.dom`, and this is server code: naming a DOM global here
   * would say this module belongs to the browser environment, which it does not.
   * The namespaced alias is what bun's own `fetch` init declares
   * (`bun-types/fetch.d.ts`), so it is the same type, spelled as what it is.
   *
   * Prefer bun's namespaced types over bare DOM globals throughout server code,
   * for the same reason. This used to be enforced by a `tools` tsconfig that
   * withheld DOM; the repo now builds ONE program that loads the full lib, so
   * the rule is design intent rather than a compiler error
   * (research/2026-09-18-global-type-check-one-program.md).
   */
  body?: Bun.BodyInit;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

/** Parse "a.b.c.d" into four octets, or null if not a valid dotted-quad IPv4. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/** Classify a dotted-quad IPv4 as private / loopback / link-local / reserved. */
function isPrivateIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;

  // 0.0.0.0/8 — "this network" / unspecified.
  if (a === 0) return true;
  // 10.0.0.0/8 — private.
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. 169.254.169.254 cloud metadata).
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private.
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — carrier-grade NAT.
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

/**
 * Classify an IPv4 OR IPv6 literal as non-public (loopback / private /
 * link-local / reserved / metadata). Conservative: anything we can't confirm is
 * public-routable returns true. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is unwrapped
 * and classified as the embedded IPv4.
 */
export function isPrivateIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase();
  if (raw === "") return true;

  // Plain IPv4.
  if (parseIpv4(raw)) return isPrivateIpv4(raw);

  // Everything below is treated as IPv6. Strip a possible zone id (fe80::1%eth0).
  const addr = raw.split("%")[0] ?? raw;

  // Unspecified address (::).
  if (addr === "::" || addr === "0:0:0:0:0:0:0:0") return true;
  // Loopback (::1).
  if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;

  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible (::1.2.3.4) — unwrap the
  // trailing dotted-quad and classify it as IPv4.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(
    addr,
  );
  if (mapped) {
    const v4 = mapped[1];
    return v4 ? isPrivateIpv4(v4) : true;
  }

  // Unique-local addresses fc00::/7 — first byte 1111110x → fc / fd prefix.
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;
  // Link-local fe80::/10 — high 10 bits 1111111010 → fe8/fe9/fea/feb prefix.
  if (
    addr.startsWith("fe8") ||
    addr.startsWith("fe9") ||
    addr.startsWith("fea") ||
    addr.startsWith("feb")
  ) {
    return true;
  }

  // A bare hostname (no colon) is not an IP literal — let the resolver classify.
  if (!addr.includes(":")) return false;

  // Any other syntactically-IPv6 address: treat as public. (Global-unicast
  // 2000::/3 etc.)
  return false;
}

/**
 * Synchronous parse + cheap literal guard. Parses `raw` with `new URL`
 * (rejecting unparseable input), requires an http(s) scheme, and fast-rejects
 * literal private/loopback/link-local hosts by pattern (no DNS). Use
 * {@link assertResolvesPublic} afterwards for the DNS-resolution check.
 */
export function parsePublicUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    // `new URL` throws TypeError on unparseable input — surface as SsrfError.
    // Any other (unexpected) error propagates.
    if (!(err instanceof TypeError)) throw err;
    throw new SsrfError(`Invalid URL: ${raw}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError(`Only http(s) URLs are supported: ${parsed.protocol}`);
  }

  // Strip IPv6 brackets so the literal classifier sees a bare address.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // `localhost` and any `.localhost` subdomain resolve to loopback by spec.
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new SsrfError(`URL host is not allowed: ${host}`);
  }

  // Fast literal-IP reject (DNS hostnames are checked later by lookup).
  if (isPrivateIp(host)) {
    throw new SsrfError(`URL host is not allowed: ${host}`);
  }

  return parsed;
}

/**
 * DNS-resolve the URL's hostname, reject if ANY resolved address is non-public
 * (a hostname can have multiple A/AAAA records; one private record is enough to
 * abuse), and return the **validated IP to pin the connection to**. If the host
 * is already an IP literal, classify it directly without a lookup and return it.
 * Throws {@link SsrfError} on rejection.
 *
 * Returning the address (rather than just asserting) is what closes the
 * DNS-rebinding TOCTOU: {@link safeFetch} dials this exact IP, so no second,
 * unguarded resolution can ever run between the check and the connect.
 */
export async function assertResolvesPublic(url: URL): Promise<string> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Literal IP — already classified by parsePublicUrl, but re-check defensively.
  if (parseIpv4(host) || host.includes(":")) {
    if (isPrivateIp(host)) {
      throw new SsrfError(`URL host is not allowed: ${host}`);
    }
    return host;
  }

  const records = await lookup(host, { all: true });
  if (records.length === 0) {
    throw new SsrfError(`URL host did not resolve: ${host}`);
  }
  for (const { address } of records) {
    if (isPrivateIp(address)) {
      throw new SsrfError(
        `URL host resolves to a non-public address: ${host} -> ${address}`,
      );
    }
  }
  // Pin the first validated record. Every returned address passed the public
  // check, so any is safe to dial; we pick one because the connection targets a
  // single IP (trading native fetch's happy-eyeballs failover for the guarantee
  // that the address we dial is exactly the one we validated).
  const first = records[0];
  if (!first) {
    throw new SsrfError(`URL host did not resolve: ${host}`);
  }
  return first.address;
}

/** The pinned request shape: a dial URL bound to a validated IP, plus the
 * original hostname re-attached as the `Host` header and (for https) the TLS
 * SNI / certificate identity. */
export interface PinnedDial {
  /** URL with the hostname swapped for the validated IP (IPv6 bracketed). */
  href: string;
  /** Original `host` (incl. non-default port) — sent as the `Host` header. */
  host: string;
  /** Hostname for SNI + cert verification; `undefined` for non-TLS targets. */
  serverName: string | undefined;
}

/**
 * Build the pinned request for a guarded `logicalUrl` and its validated `ip`.
 * Pure (no I/O) so it is unit-testable: dials the IP while keeping the hostname
 * for `Host`/SNI/cert. IPv6 addresses are bracketed in the dial URL.
 */
export function buildPinnedDial(logicalUrl: URL, ip: string): PinnedDial {
  const dial = new URL(logicalUrl.href);
  dial.hostname = ip.includes(":") ? `[${ip}]` : ip;
  return {
    href: dial.href,
    host: logicalUrl.host,
    serverName:
      logicalUrl.protocol === "https:"
        ? logicalUrl.hostname.replace(/^\[|\]$/g, "")
        : undefined,
  };
}

/**
 * Re-attach the logical (hostname) URL to a Response fetched via the IP dial
 * URL. Native fetch sets `res.url` to whatever URL it was handed — the IP here —
 * but consumers resolve relative links / redirects / `<base>` against `res.url`,
 * which must stay the hostname, not the pinned address. `Response.url` is an
 * accessor on the prototype; an own data property shadows it without disturbing
 * the streaming body.
 */
function withLogicalUrl(res: Response, logicalUrl: URL): Response {
  Object.defineProperty(res, "url", {
    value: logicalUrl.href,
    writable: false,
    configurable: true,
  });
  return res;
}

/** Merge caller headers with the pinned `Host`, dropping any caller-supplied
 * host-ish key (case-insensitive) so the validated authority always wins. */
function headersWithHost(
  headers: Record<string, string> | undefined,
  host: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() !== "host") out[k] = v;
  }
  out.host = host;
  return out;
}

/**
 * SSRF-guarded fetch. Parses + guards the target, resolves it to a validated
 * public IP, then dials **that IP** (not the hostname) with `redirect: "manual"`,
 * re-running {@link parsePublicUrl} + DNS revalidation + re-pinning on every
 * redirect hop (a public URL could otherwise 30x-redirect — or DNS-rebind — to a
 * private host, defeating the initial guard). Returns the final non-3xx Response.
 *
 * The hostname is preserved across the swap via the `Host` header and (for
 * https) `tls.serverName`, so vhost routing and certificate identity stay bound
 * to the original host while the socket targets the security-checked address.
 *
 * - `timeoutMs` (default 20s) bounds the whole request via `AbortSignal.timeout`.
 * - `signal` is honored in addition to the timeout (whichever fires first).
 * - Throws {@link SsrfError} on a blocked target/redirect, a
 *   {@link TooManyRedirectsError} on too many redirects, and fetch's / DNS's own
 *   errors otherwise — {@link isUnreachableError} tells the reachability ones
 *   apart.
 */
export async function safeFetch(
  target: string | URL,
  init: SafeFetchInit = {},
): Promise<Response> {
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // The *logical* URL keeps the hostname: it is what we guard and what relative
  // redirect `Location`s resolve against. The *dial* URL targets the pinned IP.
  let logicalUrl = parsePublicUrl(
    typeof target === "string" ? target : target.href,
  );
  let ip = await assertResolvesPublic(logicalUrl);

  // Method + body are mutated across hops: a 301/302/303 downgrades the request
  // to a bodyless GET (standard browser behavior for the POST→GET redirect of
  // the PRG pattern), while 307/308 preserve the original method + body.
  let method = init.method ?? "GET";
  let body = init.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const dial = buildPinnedDial(logicalUrl, ip);
    const signal = mergeSignals(AbortSignal.timeout(timeoutMs), init.signal);
    const res = await fetch(dial.href, {
      method,
      body,
      redirect: "manual",
      signal,
      headers: headersWithHost(init.headers, dial.host),
      // Bind SNI + cert verification to the hostname even though we dial the IP.
      ...(dial.serverName ? { tls: { serverName: dial.serverName } } : {}),
    } as RequestInit);

    if (res.status < 300 || res.status >= 400) {
      return withLogicalUrl(res, logicalUrl);
    }

    const loc = res.headers.get("location");
    // 3xx without Location — nothing to follow.
    if (!loc) return withLogicalUrl(res, logicalUrl);

    // 301/302/303: downgrade to GET and drop the body (PRG); 307/308 preserve.
    if (res.status !== 307 && res.status !== 308) {
      method = "GET";
      body = undefined;
    }

    // Resolve relative Location against the logical (hostname) URL — never the
    // IP dial URL — then re-guard and re-pin the next hop.
    logicalUrl = parsePublicUrl(new URL(loc, logicalUrl).href);
    ip = await assertResolvesPublic(logicalUrl);
  }

  throw new TooManyRedirectsError(maxRedirects);
}

/** Combine the timeout signal with an optional caller signal (first to abort wins). */
function mergeSignals(
  timeout: AbortSignal,
  extra: AbortSignal | undefined,
): AbortSignal {
  if (!extra) return timeout;
  return AbortSignal.any([timeout, extra]);
}
