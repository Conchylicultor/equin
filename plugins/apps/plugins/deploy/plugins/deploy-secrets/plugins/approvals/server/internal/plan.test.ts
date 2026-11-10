import { describe, expect, test } from "bun:test";
import {
  approvalMessage,
  checkLocalValue,
  diffSecrets,
  mergeDeclarations,
  pendingSecrets,
  previewLocalValue,
  type LocalReading,
  type RequiredSecret,
} from "./plan";
import { fingerprintSecret, importHmacKey } from "./fingerprint";

const req = (key: string, optional = false): RequiredSecret => ({
  key,
  description: `${key} description`,
  plugins: ["apps.example"],
  optional,
});

describe("diffSecrets", () => {
  test("missing value, new, value changed, approved", () => {
    const rows = diffSecrets(
      [req("A_MISSING"), req("B_NEW"), req("C_CHANGED"), req("D_OK")],
      new Map([
        ["B_NEW", "fp-b"],
        ["C_CHANGED", "fp-c2"],
        ["D_OK", "fp-d"],
      ]),
      new Map([
        ["C_CHANGED", "fp-c1"],
        ["D_OK", "fp-d"],
        // Granted once, no longer required: no row — dropped without asking.
        ["E_DROPPED", "fp-e"],
      ]),
      new Map(),
      new Map(),
    );
    expect(rows.map((r) => [r.key, r.status, r.fingerprint])).toEqual([
      ["A_MISSING", "missing-value", null],
      ["B_NEW", "new", "fp-b"],
      ["C_CHANGED", "changed", "fp-c2"],
      ["D_OK", "approved", "fp-d"],
    ]);
    expect(pendingSecrets(rows).map((r) => r.key)).toEqual([
      "A_MISSING",
      "B_NEW",
      "C_CHANGED",
    ]);
  });

  test("each row carries its key's last write, null when the store holds none", () => {
    const write = { at: 1, op: "set" as const, by: "att-1-abc", changed: true };
    const rows = diffSecrets(
      [req("A"), req("B")],
      new Map([["A", "fp-a"]]),
      new Map(),
      new Map([["A", write]]),
      new Map(),
    );
    expect(rows.map((r) => r.lastWrite)).toEqual([write, null]);
  });

  test("an optional secret with no value is not-set, and holds nothing", () => {
    const rows = diffSecrets(
      [req("OPT_UNSET", true), req("OPT_NEW", true), req("OPT_OK", true)],
      new Map([
        ["OPT_NEW", "fp-n"],
        ["OPT_OK", "fp-o"],
      ]),
      new Map([["OPT_OK", "fp-o"]]),
      new Map(),
      new Map(),
    );
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ["OPT_UNSET", "not-set"],
      ["OPT_NEW", "new"],
      ["OPT_OK", "approved"],
    ]);
    // A value, once entered, is approved like any other.
    expect(pendingSecrets(rows).map((r) => r.key)).toEqual(["OPT_NEW"]);
  });

  test("a grant for a missing value is still missing", () => {
    const [row] = diffSecrets(
      [req("K")],
      new Map(),
      new Map([["K", "fp"]]),
      new Map(),
      new Map(),
    );
    expect(row?.status).toBe("missing-value");
  });

  test("the message lists keys and their status, never a value", () => {
    const rows = diffSecrets(
      [req("RESEND_API_KEY")],
      new Map([["RESEND_API_KEY", "fp"]]),
      new Map(),
      new Map(),
      new Map(),
    );
    const msg = approvalMessage(pendingSecrets(rows));
    expect(msg).toContain("RESEND_API_KEY (new)");
    expect(msg).toContain("Secrets section");
  });
});

describe("mergeDeclarations", () => {
  test("one row per key, naming every declaring plugin", () => {
    expect(
      mergeDeclarations([
        { plugin: "b", key: "K", description: "for b", optional: false },
        { plugin: "a", key: "K", description: "for a", optional: false },
        { plugin: "a", key: "A", description: "x", optional: false },
      ]),
    ).toEqual([
      { key: "A", description: "x", plugins: ["a"], optional: false },
      {
        key: "K",
        description: "for b / for a",
        plugins: ["a", "b"],
        optional: false,
      },
    ]);
  });

  test("optional only when every declaring plugin says so", () => {
    const merged = mergeDeclarations([
      { plugin: "a", key: "BOTH", description: "x", optional: true },
      { plugin: "b", key: "BOTH", description: "x", optional: true },
      { plugin: "a", key: "MIXED", description: "x", optional: true },
      { plugin: "b", key: "MIXED", description: "x", optional: false },
    ]);
    expect(merged.map((r) => [r.key, r.optional])).toEqual([
      ["BOTH", true],
      ["MIXED", false],
    ]);
  });
});

describe("fingerprintSecret", () => {
  const hex =
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

  test("deterministic per (key, value); differs when either changes", async () => {
    const k = await importHmacKey(hex);
    const a = await fingerprintSecret(k, "K", "secret-1");
    expect(await fingerprintSecret(k, "K", "secret-1")).toBe(a);
    expect(await fingerprintSecret(k, "K", "secret-2")).not.toBe(a);
    expect(await fingerprintSecret(k, "OTHER", "secret-1")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("secret-1");
  });

  test("a different local key gives a different fingerprint", async () => {
    const k1 = await importHmacKey(hex);
    const k2 = await importHmacKey(hex.replace(/^00/, "01"));
    expect(await fingerprintSecret(k1, "K", "v")).not.toBe(
      await fingerprintSecret(k2, "K", "v"),
    );
  });

  test("a malformed stored key throws", () => {
    expect(importHmacKey("abc")).rejects.toThrow("32 hex bytes");
  });
});

describe("this computer's value", () => {
  test("a row offers it, marked when it is already the current value", () => {
    const local = (fingerprint: string) => ({
      kind: "set" as const,
      preview: "AIza…wxyz",
      fingerprint,
      caution: "advised: a separate key",
    });
    const rows = diffSecrets(
      [req("A_SAME"), req("B_OTHER"), req("C_NONE"), req("D_BAD")],
      new Map([
        ["A_SAME", "fp-a"],
        ["B_OTHER", "fp-b"],
      ]),
      new Map(),
      new Map(),
      new Map<string, LocalReading>([
        ["A_SAME", local("fp-a")],
        ["B_OTHER", local("fp-b-local")],
        ["D_BAD", { kind: "unusable" as const, reason: "has a space" }],
      ]),
    );
    expect(rows.map((r) => r.local)).toEqual([
      {
        kind: "available",
        preview: "AIza…wxyz",
        fingerprint: "fp-a",
        caution: "advised: a separate key",
        sameAsCurrent: true,
      },
      {
        kind: "available",
        preview: "AIza…wxyz",
        fingerprint: "fp-b-local",
        caution: "advised: a separate key",
        sameAsCurrent: false,
      },
      { kind: "none" },
      { kind: "unusable", reason: "has a space" },
    ]);
  });

  test("a masked preview shows only the ends, and nothing of a short value", () => {
    const key = "AIzaSyD-0123456789abcdefghijklmnopqrstu";
    expect(previewLocalValue(key, "masked")).toBe("AIza…rstu");
    expect(previewLocalValue(key, "masked")).not.toContain("0123");
    // Under 32 characters the ends would be a quarter of it or more: nothing shown.
    expect(previewLocalValue("abcdefghijklmnopqrstuvwxyz01234", "masked")).toBe(
      "••••••••",
    );
    expect(previewLocalValue("abcdef0123", "plain")).toBe("abcdef0123");
  });

  test("a local value the deploy refuses is named unusable, with why", () => {
    expect(checkLocalValue("AIzaGood_value-1")).toEqual({ ok: true });
    const bad = checkLocalValue("has space");
    expect(bad.ok).toBe(false);
  });
});
