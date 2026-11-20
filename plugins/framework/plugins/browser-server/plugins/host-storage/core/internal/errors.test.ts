import { describe, expect, it } from "bun:test";
import { HostRefusedError } from "@plugins/framework/plugins/browser-server/core";
import { BootInterruptedError, isSuspensionAbort } from "./errors";

/** A WebKit `UnknownError` with `message`. */
function webkitError(message: string): Error {
  const err = new Error(message);
  err.name = "UnknownError";
  return err;
}

/** WebKit's error, as `IDBConnectionProxy::completeOpenDBRequest` raises it. */
function webkitAbort(): Error {
  return webkitError(
    "Version change transaction on cached page is aborted to unblock other connections",
  );
}

describe("isSuspensionAbort", () => {
  it("recognises WebKit's abort of an upgrade answered while the page was cached", () => {
    expect(isSuspensionAbort(webkitAbort())).toBe(true);
  });

  it("recognises a transaction WebKit aborted while the client was suspended", () => {
    // A queued request reaching the server transaction that is gone
    // (report-1795189021-x5spzw: PGlite's IDBFS sync deleting a file).
    for (const message of [
      "Attempt to delete range from database without an in-progress transaction",
      "Attempt to store a record in an object store without an in-progress transaction",
      "Attempt to get records from database without an in-progress transaction",
      "Transaction was aborted while its process was suspended",
      "Connection on cached page closed to unblock other connections",
    ]) {
      expect(isSuspensionAbort(webkitError(message))).toBe(true);
    }
  });

  it("recognises it as the cause of a wrapping error (PGlite's open)", () => {
    const wrapped = new Error("PGlite failed to start", {
      cause: webkitAbort(),
    });
    expect(isSuspensionAbort(wrapped)).toBe(true);
  });

  it("does not take any other IndexedDB failure for it", () => {
    const quota = new Error("The quota has been exceeded.");
    quota.name = "QuotaExceededError";
    expect(isSuspensionAbort(quota)).toBe(false);
    const unknown = new Error("An internal error was encountered");
    unknown.name = "UnknownError";
    expect(isSuspensionAbort(unknown)).toBe(false);
    expect(
      isSuspensionAbort(
        webkitError(
          "Attempt to delete records from an object store in a read-only transaction",
        ),
      ),
    ).toBe(false);
    expect(isSuspensionAbort(null)).toBe(false);
    expect(isSuspensionAbort("Version change")).toBe(false);
  });

  it("is declined as an interruption, carrying the browser's error", () => {
    const cause = webkitAbort();
    const err = new BootInterruptedError(cause);
    expect(err).toBeInstanceOf(HostRefusedError);
    expect(err.refusal).toEqual({ kind: "interrupted" });
    expect(err.cause).toBe(cause);
  });
});
