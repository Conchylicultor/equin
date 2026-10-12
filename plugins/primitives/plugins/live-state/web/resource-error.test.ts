/**
 * `toResourceError` — the one mapping from a raw read failure to its typed
 * `ResourceError.kind`, and the memo that gives every observer of one failure
 * the same `ResourceError`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import { ResourceError } from "../core";
import { toResourceError } from "./resource-error";
import {
  ResourceHttpError,
  ResourceStaleReadError,
} from "./resource-http-errors";

const kindOf = (raw: unknown) => toResourceError(raw).kind;

describe("toResourceError", () => {
  test("a refusal is `refused`, its code and message the server's own", () => {
    const e = toResourceError(
      new ResourceHttpError(
        "k",
        422,
        "refused",
        undefined,
        'unknown metric "x"',
        "unknown-metric",
      ),
    );
    expect(e.kind).toBe("refused");
    expect(e.code).toBe("unknown-metric");
    expect(e.message).toBe('unknown metric "x"');
  });

  test("a refusal with no code is the tab out of date, never a code-less refusal", () => {
    const e = toResourceError(
      new ResourceHttpError("k", 422, "refused", undefined, "x"),
    );
    expect(e.kind).toBe("client-outdated");
    expect(e.code).toBeUndefined();
  });

  test("only a refusal carries a code", () => {
    expect(() => new ResourceError("refused", "x", null)).toThrow(/code/);
    expect(
      () => new ResourceError("loader-failed", "x", null, "missing"),
    ).toThrow(/code/);
    expect(new ResourceError("loader-failed", "x", null).code).toBeUndefined();
  });

  test("a contract refusal is client-outdated unless both sides run the same build", () => {
    expect(
      kindOf(new ResourceHttpError("k", 409, "contract-mismatch", "skew")),
    ).toBe("client-outdated");
    // A dev bundle cannot prove it matches: a reload is still the remedy.
    expect(
      kindOf(new ResourceHttpError("k", 409, "contract-mismatch", "unknown")),
    ).toBe("client-outdated");
    expect(kindOf(new ResourceHttpError("k", 404, "unknown-key", "skew"))).toBe(
      "client-outdated",
    );
    // Same build: the client's own encoding is the bug — reloading won't help.
    expect(
      kindOf(
        new ResourceHttpError("k", 409, "contract-mismatch", "same-build"),
      ),
    ).toBe("loader-failed");
    expect(
      kindOf(new ResourceHttpError("k", 404, "unknown-key", "same-build")),
    ).toBe("not-found");
  });

  test("status codes: 404 is not-found, anything else loader-failed", () => {
    expect(kindOf(new ResourceHttpError("k", 404))).toBe("not-found");
    expect(kindOf(new ResourceHttpError("k", 500, "loader-failed"))).toBe(
      "loader-failed",
    );
    expect(kindOf(new ResourceHttpError("k", 403, "unauthorized"))).toBe(
      "loader-failed",
    );
  });

  test("an endpoint's HTTP answer: 404 is not-found, anything else loader-failed, with the server's message", () => {
    const missing = toResourceError(new EndpointError(404, "No such metric"));
    expect(missing.kind).toBe("not-found");
    expect(missing.message).toBe("No such metric");
    const failed = toResourceError(
      new EndpointError(500, { message: "query exploded" }),
    );
    expect(failed.kind).toBe("loader-failed");
    expect(failed.message).toBe("query exploded");
    expect(kindOf(new EndpointError(400, null))).toBe("loader-failed");
  });

  test("a client-side schema rejection is client-outdated", () => {
    const parsed = z.object({ n: z.number() }).safeParse({ n: "x" });
    if (parsed.success) throw new Error("unreachable");
    expect(kindOf(parsed.error)).toBe("client-outdated");
  });

  test("no answer (fetch's TypeError) and a lost version race are transport", () => {
    expect(kindOf(new TypeError("Failed to fetch"))).toBe("transport");
    expect(kindOf(new ResourceStaleReadError("k", 1, 2, "stale-version"))).toBe(
      "transport",
    );
  });

  test("anything else is loader-failed, keeping the raw error as cause", () => {
    const raw = new Error("boom");
    const e = toResourceError(raw);
    expect(e).toBeInstanceOf(ResourceError);
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("loader-failed");
    expect(e.message).toBe("boom");
    expect(e.cause).toBe(raw);
    expect(kindOf("a string")).toBe("loader-failed");
  });

  test("memoized per raw error, and idempotent on a ResourceError", () => {
    const raw = new Error("once");
    const e = toResourceError(raw);
    expect(toResourceError(raw)).toBe(e);
    expect(toResourceError(e)).toBe(e);
  });
});
