import { describe, expect, test } from "bun:test";
import {
  approvalMessage,
  diffSecrets,
  mergeDeclarations,
  pendingSecrets,
  type RequiredSecret,
} from "./plan";
import { fingerprintSecret, importHmacKey } from "./fingerprint";

/** Await `p` and return what it rejected with; throw if it resolved. (`expect(p).rejects` is typed `void` under bun:test.) */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const req = (key: string): RequiredSecret => ({
  key,
  description: `${key} description`,
  plugins: ["apps.example"],
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

  test("a grant for a missing value is still missing", () => {
    const [row] = diffSecrets([req("K")], new Map(), new Map([["K", "fp"]]));
    expect(row?.status).toBe("missing-value");
  });

  test("the message lists keys and their status, never a value", () => {
    const rows = diffSecrets(
      [req("RESEND_API_KEY")],
      new Map([["RESEND_API_KEY", "fp"]]),
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
        { plugin: "b", key: "K", description: "for b" },
        { plugin: "a", key: "K", description: "for a" },
        { plugin: "a", key: "A", description: "x" },
      ]),
    ).toEqual([
      { key: "A", description: "x", plugins: ["a"] },
      { key: "K", description: "for b / for a", plugins: ["a", "b"] },
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

  test("a malformed stored key throws", async () => {
    expect(String(await rejection(importHmacKey("abc")))).toContain(
      "32 hex bytes",
    );
  });
});
