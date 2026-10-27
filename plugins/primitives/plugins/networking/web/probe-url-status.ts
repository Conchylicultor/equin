import type { Transport } from "./transport";

/** What a URL answers, without keeping its body. */
export type UrlStatus =
  | { kind: "status"; status: number }
  /** No HTTP answer at all: offline, refused, or a cross-origin URL that does
   *  not allow this page to read its response. */
  | { kind: "unreachable" };

/**
 * Ask a URL for its HTTP status — for a resource the page loaded some other
 * way (an `<img>`, a `<video>`) whose element only reports that it failed, not
 * why. A GET, since not every route serves HEAD; the body is cancelled unread.
 * Bypasses the HTTP cache, so the answer is the server's now.
 *
 * Asked over the subtree's `transport`, never the page's global `fetch`: the
 * URL is usually the app's own (`/api/attachments/…`), and the page's request
 * guard refuses a same-origin `/api` request that does not go through the
 * transport.
 */
export async function probeUrlStatus(
  transport: Transport,
  url: string,
): Promise<UrlStatus> {
  let res: Response;
  try {
    res = await transport.fetch(url, { cache: "no-store" });
  } catch (err) {
    // fetch rejects with a TypeError for every network-level failure.
    if (err instanceof TypeError) return { kind: "unreachable" };
    throw err;
  }
  await res.body?.cancel();
  return { kind: "status", status: res.status };
}
