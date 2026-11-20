// Where the document's first byte went: the 0 → responseStart window of a page
// load, split into the stretches Navigation Timing can tell apart. A first byte
// read as one number ("TTFB 3.3 s") cannot say whether the visitor waited on
// the server or on their own network; the split can.

/**
 * The fields of a `PerformanceNavigationTiming` entry the split reads (ms from
 * the navigation's start; 0 = the phase did not happen, e.g. a reused
 * connection has no DNS, TCP or TLS). `nextHopProtocol` may be missing or
 * empty where a browser does not report it.
 */
export interface NavigationTimingFields {
  fetchStart: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  nextHopProtocol?: string;
}

/** The longest protocol name kept (ALPN ids are short: `h2`, `h3`, `http/1.1`). */
export const MAX_PROTOCOL_LENGTH = 32;

/**
 * The document's first byte, split (whole ms; the parts add up to `totalMs`
 * exactly):
 *
 * - `beforeFetchMs` — navigation start → fetch start: every redirect (a
 *   cross-origin one — `http://` → `https://`, a link shortener — is only
 *   visible here), the browser setting the navigation up, a service worker
 *   starting.
 * - `dnsMs` — the domain lookup.
 * - `tcpMs` — the TCP handshake (one round trip); 0 on HTTP/3, which has no
 *   TCP.
 * - `tlsMs` — the TLS handshake (one round trip on TLS 1.3); on HTTP/3 the
 *   whole QUIC handshake.
 * - `waitMs` — request sent → first byte: one round trip plus the server's
 *   own time.
 * - `otherMs` — the gaps between those (the browser queueing, a cache
 *   lookup): what is left of `totalMs`.
 * - `protocol` — the protocol the document came over (`h2`, `h3`,
 *   `http/1.1`), null when the browser does not say.
 */
export interface FirstByteSplit {
  totalMs: number;
  beforeFetchMs: number;
  dnsMs: number;
  tcpMs: number;
  tlsMs: number;
  waitMs: number;
  otherMs: number;
  protocol: string | null;
}

/**
 * The split of one navigation's first byte. PURE. Null when the entry has no
 * first byte (a load still in flight, or a browser that zeroes the entry).
 *
 * The entry's instants are read as one timeline from 0 to the first byte:
 * each is rounded, an unset one (0) takes the instant before it, and each is
 * clamped between the one before it and the first byte — so no part is
 * negative, none outgrows the total, and they add up exactly whatever a
 * browser's quirks (a `secureConnectionStart` before `connectStart` on a
 * reused connection).
 */
export function firstByteSplit(
  nav: NavigationTimingFields,
): FirstByteSplit | null {
  if (!(nav.responseStart > 0)) return null;
  const totalMs = Math.round(nav.responseStart);
  let at = 0;
  const next = (instant: number): number => {
    if (instant > 0) at = Math.min(totalMs, Math.max(at, Math.round(instant)));
    return at;
  };
  const fetch = next(nav.fetchStart);
  const dnsStart = next(nav.domainLookupStart);
  const dnsEnd = next(nav.domainLookupEnd);
  const connectStart = next(nav.connectStart);
  // Without TLS (or on a reused connection) secureConnectionStart is 0: the
  // whole connection is TCP.
  const tlsStart =
    nav.secureConnectionStart > 0 ? next(nav.secureConnectionStart) : null;
  const connectEnd = next(nav.connectEnd);
  const requestStart = next(nav.requestStart);
  const handshakeStart = tlsStart ?? connectEnd;
  const protocol = protocolOf(nav.nextHopProtocol);
  const quic = protocol !== null && protocol.startsWith("h3");
  const tcpMs = quic ? 0 : handshakeStart - connectStart;
  const tlsMs = quic ? connectEnd - connectStart : connectEnd - handshakeStart;
  const dnsMs = dnsEnd - dnsStart;
  const waitMs = totalMs - requestStart;
  return {
    totalMs,
    beforeFetchMs: fetch,
    dnsMs,
    tcpMs,
    tlsMs,
    waitMs,
    otherMs: totalMs - fetch - dnsMs - tcpMs - tlsMs - waitMs,
    protocol,
  };
}

function protocolOf(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  return raw.slice(0, MAX_PROTOCOL_LENGTH);
}
