// Where the document's first byte went: the 0 → responseStart window of a page
// load, split into the stretches Navigation Timing can tell apart. A first byte
// read as one number ("TTFB 3.3 s") cannot say whether the visitor waited on
// the server or on their own network; the split can.

/**
 * The fields of a `PerformanceNavigationTiming` entry the split reads (ms from
 * the navigation's start). A phase that did not happen reads as the instant
 * before it (a reused connection's DNS and connect fields equal `fetchStart`)
 * or, in some browsers, as 0 — either is read as "no time spent".) `nextHopProtocol` may be missing or
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
 * - `queueMs` — fetch start → DNS start.
 * - `stallMs` — DNS end → connect start.
 * - `sendMs` — connected → request sent.
 * - `otherMs` — the three gaps together (`queueMs + stallMs + sendMs`), kept
 *   so a split recorded before the gaps were named still reads.
 *
 * The three gaps are named by POSITION, not by cause: the browser's own wait
 * (its HTTP cache lookup, a request queued for a free connection — Chrome's
 * DevTools "Queueing" / "Stalled", Firefox's "Blocked") lands in whichever
 * gap the browser's fields leave it. In Chrome, with DNS timed it is
 * `queueMs` (Chrome trims connectStart to domainLookupEnd, so `stallMs` is
 * ~0); with no DNS timing (a cached lookup reported as fetchStart) it can be
 * `stallMs`; on a reused or preconnected connection every DNS and connect
 * field equals fetchStart, so it is `sendMs`. Large gaps say "the browser
 * waited before talking to the server", never "the server was slow".
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
  queueMs: number;
  stallMs: number;
  sendMs: number;
  otherMs: number;
  protocol: string | null;
}

/** The three gaps `otherMs` sums, named — absent on a split recorded before they were. */
export const FIRST_BYTE_GAPS = ["queueMs", "stallMs", "sendMs"] as const;

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
  const queueMs = dnsStart - fetch;
  const stallMs = connectStart - dnsEnd;
  const sendMs = requestStart - connectEnd;
  return {
    totalMs,
    beforeFetchMs: fetch,
    dnsMs: dnsEnd - dnsStart,
    tcpMs,
    tlsMs,
    waitMs: totalMs - requestStart,
    queueMs,
    stallMs,
    sendMs,
    otherMs: queueMs + stallMs + sendMs,
    protocol,
  };
}

/**
 * Whether the split timed a connection being set up: some DNS, TCP or TLS
 * time. False is ambiguous by construction — the entry looks the same for a
 * connection the browser reused (nothing to set up) and for one it opened
 * without timing it (Safari often reports every DNS and connect field as the
 * fetch start). Then any setup is counted in the later parts (connect →
 * request, request → response), so those cannot be read as the server's. PURE.
 */
export function connectionTimed(
  split: Pick<FirstByteSplit, "dnsMs" | "tcpMs" | "tlsMs">,
): boolean {
  return split.dnsMs + split.tcpMs + split.tlsMs > 0;
}

function protocolOf(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  return raw.slice(0, MAX_PROTOCOL_LENGTH);
}
