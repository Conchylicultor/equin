/**
 * Page-error / console-error / failed-request capture.
 *
 * `page.on("pageerror", …)` appeared in ~12 of the pre-move scripts, console-error
 * collection in 4 more, and failed-request collection in one — each with its own
 * array shape. One shape here, with live arrays a script can assert on at the end
 * ("no page errors during the run") without threading state through the flow.
 */
import type { Page, Request } from "playwright";

export interface Captured {
  pageErrors: string[];
  consoleErrors: string[];
  /**
   * `<method> <url> — <failure text>` for requests that never got a response
   * (see `requestFailure`). A successful 204 is not in here.
   */
  failedRequests: string[];
}

/**
 * The failure text for a request that genuinely never got a response, or `null`
 * when a response did arrive and the `requestfailed` event is Chromium's
 * empty-body artifact.
 *
 * Chromium, as seen through Playwright, fires `requestfailed … net::ERR_ABORTED`
 * for a SUCCESSFUL fetch whose response body is empty — a 204, or a 200 with no
 * body — while the page's `await fetch()` resolves normally. Every void endpoint
 * answers 204 (`infra/endpoints/core/implement.ts`), so without this every
 * `clientLog` flush, and every other void mutation, reads as a failed request.
 * The two cases differ synchronously: the artifact has
 * `timing().responseStart >= 0` (and `response()` resolves to the real status),
 * while a genuine abort — `AbortController`, a navigation, a close mid-flight,
 * a dial failure — has `responseStart === -1` and no response.
 * Diagnosis: research/2026-09-25-framework-e2e-empty-body-requestfailed.md.
 */
export function requestFailure(req: Request): string | null {
  if (req.timing().responseStart >= 0) return null;
  return req.failure()?.errorText ?? "unknown";
}

/**
 * Attach the three listeners and return the arrays they fill. Each line is also
 * echoed to stdout as it happens (prefixed with `label` when several contexts are
 * in play, e.g. the A/B pages of a convergence test) so a failing run is
 * diagnosable from the transcript alone, not just from the final assertion.
 */
export function capture(page: Page, label?: string): Captured {
  const tag = label ? `(${label})` : "";
  const captured: Captured = {
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
  };

  page.on("pageerror", (err) => {
    captured.pageErrors.push(err.message);
    console.log(`PAGEERROR${tag}:`, err.message);
  });

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    captured.consoleErrors.push(msg.text());
    console.log(`CONSOLE-ERROR${tag}:`, msg.text());
  });

  // Chromium's console line for an error status names no URL ("Failed to load
  // resource: the server responded with a status of 403"), so a transcript
  // could not say WHAT was refused. Printed beside it, never counted: an error
  // status may be what a script asserts on.
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const req = res.request();
    console.log(
      `HTTP-ERROR${tag}: ${res.status()} ${req.method()} ${res.url()}`,
    );
  });

  page.on("requestfailed", (req) => {
    const failure = requestFailure(req);
    if (failure === null) return;
    const line = `${req.method()} ${req.url()} — ${failure}`;
    captured.failedRequests.push(line);
    console.log(`REQUESTFAILED${tag}:`, line);
  });

  return captured;
}
