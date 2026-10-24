import { describe, expect, test } from "bun:test";
import { SsrfError } from "@plugins/infra/plugins/safe-fetch/server";
import {
  BrowserFetchError,
  browserInstallFailed,
  browserInstalling,
  browserUnavailable,
} from "./errors";

describe("BrowserFetchError", () => {
  // Classification downstream is NAME-based, not instanceof-based: the error
  // crosses a plugin boundary (and may cross a module-instance boundary with
  // it), and a name comparison survives both.
  test("sets name in the constructor", () => {
    const err = new BrowserFetchError(
      "navigation-timeout",
      "https://example.com/",
      "boom",
    );
    expect(err.name).toBe("BrowserFetchError");
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("navigation-timeout");
    expect(err.url).toBe("https://example.com/");
  });

  test("keeps the cause for the underlying failure", () => {
    const cause = new Error("net::ERR_ABORTED");
    const err = new BrowserFetchError("navigation-failed", "https://x/", "m", {
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  // `SsrfError` propagates UNWRAPPED out of `browserFetch`. Wrapping it would
  // silently downgrade a terminal security refusal into an anonymous transient
  // for any caller classifying on `name === "SsrfError"`.
  test("is not the class an SSRF refusal is reported as", () => {
    const ssrf = new SsrfError("URL host is not allowed: 127.0.0.1");
    expect(ssrf.name).toBe("SsrfError");
    expect(ssrf).not.toBeInstanceOf(BrowserFetchError);
  });
});

describe("browser-unavailable reasons", () => {
  test("installing says so, and is still a BrowserFetchError by name", () => {
    const err = browserInstalling("https://example.com/");
    expect(err.kind).toBe("browser-unavailable");
    expect(err.reason).toBe("installing");
    expect(err.name).toBe("BrowserFetchError");
    expect(err).toBeInstanceOf(BrowserFetchError);
    expect(err.message).toContain("being installed");
  });

  test("install-failed carries the failure and the retry command", () => {
    const err = browserInstallFailed("https://example.com/", "curl: 404.");
    expect(err.reason).toBe("install-failed");
    expect(err.message).toContain("curl: 404.");
    expect(err.message).toContain("./equin deps install chromium");
  });

  test("launch-failed keeps the launch error", () => {
    const err = browserUnavailable(
      "https://example.com/",
      new Error("Executable doesn't exist"),
    );
    expect(err.kind).toBe("browser-unavailable");
    expect(err.reason).toBe("launch-failed");
    expect(err.message).toContain("Executable doesn't exist");
  });
});
