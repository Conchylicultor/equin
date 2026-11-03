import { describe, expect, test } from "bun:test";
import {
  ResourceContractError,
  ResourceRefusal,
  contractVerdict,
  parseResourceBytesHeaders,
  parseResourceHttpErrorBody,
  resourceBytesHeaders,
} from "./protocol";

describe("contractVerdict", () => {
  test("a client that names no build predates the protocol: skew", () => {
    expect(contractVerdict(undefined, "g1")).toBe("skew");
    expect(contractVerdict(undefined, null)).toBe("skew");
  });
  test("a dev bundle or an unknown server graph cannot be judged", () => {
    expect(contractVerdict("dev", "g1")).toBe("unknown");
    expect(contractVerdict("g1", null)).toBe("unknown");
  });
  test("a different graph is skew, the same graph is a real bug", () => {
    expect(contractVerdict("g0", "g1")).toBe("skew");
    expect(contractVerdict("g1", "g1")).toBe("same-build");
  });
});

describe("parseResourceHttpErrorBody", () => {
  test("reads a typed body", () => {
    expect(
      parseResourceHttpErrorBody({
        reason: "contract-mismatch",
        verdict: "skew",
        detail: "x",
      }),
    ).toEqual({ reason: "contract-mismatch", verdict: "skew", detail: "x" });
  });
  test("reads a refusal's code", () => {
    expect(
      parseResourceHttpErrorBody({
        reason: "refused",
        code: "missing",
        detail: "no such file",
      }),
    ).toEqual({ reason: "refused", code: "missing", detail: "no such file" });
    expect(parseResourceHttpErrorBody({ reason: "refused", code: 3 })).toEqual({
      reason: "refused",
    });
  });
  test("refuses anything that is not one", () => {
    expect(parseResourceHttpErrorBody("Loader failed")).toBeUndefined();
    expect(parseResourceHttpErrorBody({ reason: "nope" })).toBeUndefined();
    expect(parseResourceHttpErrorBody(null)).toBeUndefined();
  });
  test("drops an unknown verdict rather than trusting it", () => {
    expect(
      parseResourceHttpErrorBody({ reason: "unknown-key", verdict: "maybe" }),
    ).toEqual({ reason: "unknown-key" });
  });
});

test("ResourceContractError keeps the detail as its message", () => {
  const err = new ResourceContractError("k", "bad params");
  expect(err.message).toBe("bad params");
  expect(err.key).toBe("k");
  expect(err).toBeInstanceOf(Error);
});

test("ResourceRefusal carries its code and message", () => {
  const err = new ResourceRefusal("missing", "no such file");
  expect(err.code).toBe("missing");
  expect(err.message).toBe("no such file");
  expect(err).toBeInstanceOf(Error);
  expect(() => new ResourceRefusal("", "x")).toThrow(/empty code/);
});

describe("bytes read envelope headers", () => {
  test("round-trips through the headers, watermark optional", () => {
    const full = new Headers(
      resourceBytesHeaders({ version: 4, epoch: "boot-1", watermark: "77" }),
    );
    expect(full.get("content-type")).toBe("application/octet-stream");
    expect(parseResourceBytesHeaders("k", full)).toEqual({
      version: 4,
      epoch: "boot-1",
      watermark: "77",
    });
    const bare = new Headers(
      resourceBytesHeaders({ version: 0, epoch: "boot-1" }),
    );
    expect(parseResourceBytesHeaders("k", bare)).toEqual({
      version: 0,
      epoch: "boot-1",
    });
  });
  test("a content-type parameter is tolerated", () => {
    const h = new Headers(resourceBytesHeaders({ version: 1, epoch: "e" }));
    h.set("content-type", "application/octet-stream; x=y");
    expect(parseResourceBytesHeaders("k", h).version).toBe(1);
  });
  test("throws on a JSON answer or a missing / malformed envelope", () => {
    const json = new Headers(resourceBytesHeaders({ version: 1, epoch: "e" }));
    json.set("content-type", "application/json");
    expect(() => parseResourceBytesHeaders("k", json)).toThrow(/content-type/);
    for (const version of [null, "", "-1", "1.5", "x"]) {
      const h = new Headers(resourceBytesHeaders({ version: 1, epoch: "e" }));
      if (version === null) h.delete("x-resource-version");
      else h.set("x-resource-version", version);
      expect(() => parseResourceBytesHeaders("k", h)).toThrow(/envelope/);
    }
    const noEpoch = new Headers(
      resourceBytesHeaders({ version: 1, epoch: "e" }),
    );
    noEpoch.delete("x-resource-epoch");
    expect(() => parseResourceBytesHeaders("k", noEpoch)).toThrow(/envelope/);
  });
});
