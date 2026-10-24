import type { BrowserFetchFailureKind } from "./types";

/**
 * Everything that prevented reading the page at all.
 *
 * `name` is set in the constructor because classification downstream is
 * **name-based**, not `instanceof`-based: the error crosses a plugin boundary
 * and may cross a module-instance boundary with it, and a name comparison
 * survives both. `kind` is the machine-readable half; the message is the
 * human-readable one.
 *
 * Note what this class deliberately does NOT wrap: `SsrfError`. A refusal to
 * reach a private address propagates unwrapped, so a caller that already
 * classifies `SsrfError` as terminal keeps classifying it identically whether
 * the read went through `safeFetch` or through a browser. Wrapping it would
 * silently downgrade a terminal security refusal into an anonymous transient.
 */
export class BrowserFetchError extends Error {
  readonly kind: BrowserFetchFailureKind;
  readonly url: string;

  constructor(
    kind: BrowserFetchFailureKind,
    url: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BrowserFetchError";
    this.kind = kind;
    this.url = url;
  }
}

/**
 * Why no browser could be started — the half of `browser-unavailable` a
 * caller may want to branch on:
 *
 * - `installing` — Chromium is an on-demand dependency and is not installed
 *   yet; the install has been requested (or is already running). Try again
 *   in a few minutes. Never a statement about the URL.
 * - `install-failed` — the last install failed; it is not retried from a
 *   request path. The message carries the failure and the command that
 *   retries it.
 * - `launch-failed` — installed, but Playwright could not load or launch it.
 */
export type BrowserUnavailableReason =
  "installing" | "install-failed" | "launch-failed";

/**
 * The "no browser" error: `kind` is always `browser-unavailable`, `reason`
 * says which of the three. Still named `BrowserFetchError`, so a caller
 * classifying by name buckets it exactly as before (transient: parking a
 * source over a missing binary would be a lie).
 */
export class BrowserUnavailableError extends BrowserFetchError {
  readonly reason: BrowserUnavailableReason;

  constructor(
    reason: BrowserUnavailableReason,
    url: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super("browser-unavailable", url, message, options);
    this.reason = reason;
  }
}

/** The command that installs (or reinstalls) the browser by hand. */
export const INSTALL_BROWSER_COMMAND = "./equin deps install chromium";

/**
 * Chromium is not installed yet and its install has been requested: the page
 * can be read once it lands. Not a failure of the URL, and not a stand-in page.
 */
export function browserInstalling(url: string): BrowserUnavailableError {
  return new BrowserUnavailableError(
    "installing",
    url,
    `Chromium is being installed (an on-demand dependency, ~280 MB — see Settings → Dependencies), ` +
      `so ${url} cannot be read in a browser yet. Try again once it is ready.`,
  );
}

/** The last install of Chromium failed; a request path does not retry it. */
export function browserInstallFailed(
  url: string,
  failure: string,
): BrowserUnavailableError {
  return new BrowserUnavailableError(
    "install-failed",
    url,
    `Chromium could not be installed, so ${url} cannot be read in a browser: ${failure} ` +
      `Retry from Settings → Dependencies, or run \`${INSTALL_BROWSER_COMMAND}\`.`,
  );
}

/** Installed, but Playwright could not load or launch it. */
export function browserUnavailable(
  url: string,
  cause: unknown,
): BrowserUnavailableError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new BrowserUnavailableError(
    "launch-failed",
    url,
    `Could not start a browser to load ${url}. ` +
      `If the install is damaged, \`${INSTALL_BROWSER_COMMAND}\` reinstalls it. (${detail})`,
    { cause },
  );
}
