import { describe, expect, it } from "bun:test";
import { HostRefusedError } from "@plugins/framework/plugins/browser-server/core";
import { BootInterruptedError, isSuspendedUpgradeAbort } from "./errors";

/** WebKit's error, as `IDBConnectionProxy::completeOpenDBRequest` raises it. */
function webkitAbort(): Error {
  const err = new Error(
    "Version change transaction on cached page is aborted to unblock other connections",
  );
  err.name = "UnknownError";
  return err;
}

describe("isSuspendedUpgradeAbort", () => {
  it("recognises WebKit's abort of an upgrade answered while the page was cached", () => {
    expect(isSuspendedUpgradeAbort(webkitAbort())).toBe(true);
  });

  it("recognises it as the cause of a wrapping error (PGlite's open)", () => {
    const wrapped = new Error("PGlite failed to start", {
      cause: webkitAbort(),
    });
    expect(isSuspendedUpgradeAbort(wrapped)).toBe(true);
  });

  it("does not take any other IndexedDB failure for it", () => {
    const quota = new Error("The quota has been exceeded.");
    quota.name = "QuotaExceededError";
    expect(isSuspendedUpgradeAbort(quota)).toBe(false);
    const unknown = new Error("An internal error was encountered");
    unknown.name = "UnknownError";
    expect(isSuspendedUpgradeAbort(unknown)).toBe(false);
    expect(isSuspendedUpgradeAbort(null)).toBe(false);
    expect(isSuspendedUpgradeAbort("Version change")).toBe(false);
  });

  it("is declined as an interruption, carrying the browser's error", () => {
    const cause = webkitAbort();
    const err = new BootInterruptedError(cause);
    expect(err).toBeInstanceOf(HostRefusedError);
    expect(err.refusal).toEqual({ kind: "interrupted" });
    expect(err.cause).toBe(cause);
  });
});
