import { EndpointNetworkError } from "@plugins/infra/plugins/endpoints/core";
import type { HostReach } from "@plugins/infra/plugins/health/web";

// A request that got no HTTP answer at all, thrown where nothing caught it.
//
// A page's fetch rejects with a TypeError when no answer came back: the
// visitor's network dropped, a phone suspended its backgrounded tab's network,
// the host itself is unreachable — or the request is one the browser refuses
// to send or read (CORS, a blocked mixed-content URL, an extension). The page
// cannot tell those apart from the error alone. It can ask: whether its own
// host answers HTTP right now (`reachHost`, infra/health — the same signal the
// live-state wedge watchdog files on).
//
// - The host answers → the network is up and this request still failed: the
//   request is what is wrong. Filed, as before.
// - No answer either → the visitor's link (or the whole host) is down. Not a
//   bug of the page, and a report that could only reach us once the link came
//   back (equin.ai, 2026-11-18 00:35:17 UTC: an analytics beacon of a visitor
//   offline for 4 min; 2026-11-18 18:13 UTC: a Firefox Android visitor's beacon
//   from a backgrounded tab). Warned to the console, not filed.

/**
 * The messages browsers give a fetch that got no answer. A closed, browser-owned
 * set: a bare one is the only shape a raw (non-endpoint) fetch's failure has.
 */
const NO_ANSWER_MESSAGES: readonly RegExp[] = [
  /^Failed to fetch\b/, // Chromium
  /^NetworkError when attempting to fetch resource\.?$/, // Firefox
  /^Load failed$/, // Safari
  /^The network connection was lost\.?$/, // Safari
  /^The Internet connection appears to be offline\.?$/, // Safari
];

/** Whether `err` is a fetch that got no HTTP answer at all. */
export function isFetchNoAnswer(err: unknown): err is TypeError {
  if (err instanceof EndpointNetworkError) return true;
  return (
    err instanceof TypeError &&
    NO_ANSWER_MESSAGES.some((re) => re.test(err.message))
  );
}

/**
 * Files a caught crash — unless it is a fetch with no answer on a page whose
 * host does not answer either (the visitor's network, not the page: warned to
 * the console instead). Every other error is filed at once, untouched.
 */
export async function fileUnlessOffline(
  err: unknown,
  file: () => void,
  reach: () => Promise<HostReach>,
): Promise<void> {
  if (!isFetchNoAnswer(err)) {
    file();
    return;
  }
  const r = await reach();
  if (r.kind === "answered") {
    file();
    return;
  }
  console.warn(
    `[reports] not filed — a request got no answer while this page's host did not answer either (the visitor's network): ${err.message}`,
  );
}
