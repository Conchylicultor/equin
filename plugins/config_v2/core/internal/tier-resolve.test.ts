import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { isForeignOverride, readTypedConfig, validationIssues, effective } from "./tier-logic";
import { computeHash } from "./config-proxy";
import type { ConfigFileContent, ConfigProxy } from "./config-proxy";
import type { ConfigDescriptor, JsonValue } from "./types";

// Minimal in-memory proxy. `null` = file absent.
function memProxy(state: ConfigFileContent | null): ConfigProxy {
  return {
    read: () => (state ? { ...state } : null),
    write: () => {},
    exists: () => state !== null,
  };
}

// A reorder-shaped descriptor: one `items` field, passthrough + default-backfill
// (exactly how defineConfig composes a reorder schema).
const descriptor = {
  name: "conversation.header",
  fields: { items: {} },
  defaults: { items: [] },
  schema: z.object({ items: z.array(z.string()).default([]) }).passthrough(),
} as unknown as ConfigDescriptor;

const ORIGIN = { items: ["a:title", "b:status", "c:model"] };
const H = computeHash(ORIGIN as JsonValue);
const origin = memProxy({ content: ORIGIN as JsonValue, hash: H });

// The dead pre-`items` format, recorded against the CURRENT origin hash so it is
// NOT hash-stale — exactly the production footgun.
const foreignOverride = memProxy({
  content: { order: ["x:old"], hidden: [] } as JsonValue,
  hash: H,
});

describe("isForeignOverride", () => {
  test("dead {order,hidden} reorder doc → foreign", () => {
    expect(isForeignOverride({ order: [], hidden: [] }, ["items"])).toBe(true);
  });
  test("current {items} doc → not foreign", () => {
    expect(isForeignOverride({ items: [] }, ["items"])).toBe(false);
  });
  test("empty {} / absent / non-object → not foreign", () => {
    expect(isForeignOverride({}, ["items"])).toBe(false);
    expect(isForeignOverride(undefined, ["items"])).toBe(false);
    expect(isForeignOverride(["items"], ["items"])).toBe(false);
  });
});

describe("readTypedConfig degrades an unusable override to the ORIGIN, not empty defaults", () => {
  test("foreign override → origin items (authored order preserved)", () => {
    expect(readTypedConfig(descriptor, origin, foreignOverride)).toEqual(ORIGIN);
  });

  test("schema-invalid override (shares field) → origin items", () => {
    const bad = memProxy({ content: { items: "not-an-array" } as JsonValue, hash: H });
    expect(readTypedConfig(descriptor, origin, bad)).toEqual(ORIGIN);
  });

  test("valid override still wins", () => {
    const ok = memProxy({ content: { items: ["b:status"] } as JsonValue, hash: H });
    expect(readTypedConfig(descriptor, origin, ok)).toEqual({ items: ["b:status"] });
  });

  test("no override → origin", () => {
    expect(readTypedConfig(descriptor, origin, memProxy(null))).toEqual(ORIGIN);
  });

  test("no origin and no override → code defaults", () => {
    expect(readTypedConfig(descriptor, memProxy(null), memProxy(null))).toEqual({ items: [] });
  });
});

describe("validationIssues surfaces the unusable override LOUDLY", () => {
  test("foreign override → invalid issue naming the dead keys", () => {
    const issues = validationIssues(descriptor, origin, foreignOverride);
    expect(issues).not.toBeNull();
    expect(issues!).toHaveLength(1);
    expect(issues![0]!.message).toContain("order");
    expect(issues![0]!.message).toContain("hidden");
    expect(issues![0]!.path).toEqual([]);
  });

  test("valid override → no issue", () => {
    const ok = memProxy({ content: { items: ["b:status"] } as JsonValue, hash: H });
    expect(validationIssues(descriptor, origin, ok)).toBeNull();
  });

  test("override that does not parse → its syntax errors, and the origin applies", () => {
    const unparsed = memProxy({
      content: { items: ["b:status"] } as JsonValue,
      hash: null,
      syntaxErrors: ["JSONC syntax error: CommaExpected at line 3"],
    });
    expect(readTypedConfig(descriptor, origin, unparsed)).toEqual(ORIGIN);
    const issues = validationIssues(descriptor, origin, unparsed);
    expect(issues).toHaveLength(1);
    expect(issues![0]!.message).toContain("CommaExpected at line 3");
    expect(issues![0]!.path).toEqual([]);
  });

  test("schema-invalid override → schema issues", () => {
    const bad = memProxy({ content: { items: 5 } as JsonValue, hash: H });
    expect(validationIssues(descriptor, origin, bad)).not.toBeNull();
  });

  test("stale override (hash mismatch) is a hash conflict, not invalid → null here", () => {
    const stale = memProxy({ content: { order: [] } as JsonValue, hash: "deadbeefdead" });
    expect(validationIssues(descriptor, origin, stale)).toBeNull();
  });
});

describe("effective still returns the raw stored override (unchanged)", () => {
  test("foreign override is the raw stored value surfaced as overrideValues", () => {
    expect(effective(origin, foreignOverride)).toEqual({ order: ["x:old"], hidden: [] });
  });
});
