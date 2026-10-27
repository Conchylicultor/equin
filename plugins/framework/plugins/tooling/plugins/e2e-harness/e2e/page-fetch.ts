/**
 * Calling the app's own API AS THE PAGE, from the script's Node side.
 *
 * The page itself may not: the request guard
 * (`primitives/networking/plugins/request-guard`) refuses every same-origin
 * `/api` | `/ws` | `/gateway` request page code issues outside the app's own
 * transport, so a `page.evaluate(() => fetch("/api/…"))` now rejects with a
 * `RawApiRequestError`. A script that wants to seed rows or read what the
 * server holds asks through Playwright's `page.request` instead, which is the
 * page's BROWSER CONTEXT talking: the same cookies, and the same context-wide
 * `extraHTTPHeaders` — so the agent-origin provenance `withBrowser` stamps
 * (or the `browser_*` session's, under `--attach`) is carried exactly as an
 * in-page fetch carried it. Not `agentFetch`: that one is the script's own
 * identity, and has no cookies.
 *
 * `path` is app-relative and resolved against the page's CURRENT url, i.e.
 * the origin an in-page `fetch(path)` would have hit — never re-derived from
 * the target, so an `--attach`ed tab on another deploy keeps its own.
 *
 * The answer is a standard fetch `Response`, so a migrated call site keeps its
 * `res.ok` / `res.status` / `await res.json()` / `await res.text()` verbatim.
 */
import type { Page } from "playwright";

export interface PageFetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** The request body, already serialized (as `fetch`'s `body`). */
  body?: string;
}

/** Statuses a `Response` may not carry a body for (the constructor throws). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export async function pageFetch(
  page: Page,
  path: string,
  init: PageFetchInit = {},
): Promise<Response> {
  if (!path.startsWith("/")) {
    throw new Error(
      `pageFetch: '${path}' is not an app-relative path — pass '/api/…'`,
    );
  }
  const current = page.url();
  if (!/^https?:/.test(current)) {
    throw new Error(
      `pageFetch(${path}): the page is at '${current}', which has no app origin — navigate it to the app first`,
    );
  }
  const res = await page.request.fetch(new URL(path, current).href, {
    method: init.method ?? "GET",
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body === undefined ? {} : { data: init.body }),
    // A fetch never throws on a status; neither does this.
    failOnStatusCode: false,
  });
  const status = res.status();
  const body = NULL_BODY_STATUSES.has(status)
    ? null
    : new Uint8Array(await res.body());
  return new Response(body, {
    status,
    statusText: res.statusText(),
    headers: res.headers(),
  });
}
