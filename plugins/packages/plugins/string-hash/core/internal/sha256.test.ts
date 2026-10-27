import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSha256, sha1Hex, sha256Hex } from "./sha256";

const TEXTS = [
  "",
  "a",
  "hello world",
  "CREATE OR REPLACE VIEW tasks_v AS SELECT 1",
  "unicode ✓ — é ü 日本語 🎵",
  "x".repeat(10_000),
];

describe("sha256Hex", () => {
  test("matches node:crypto's hex digest", () => {
    for (const text of TEXTS) {
      expect(sha256Hex(text)).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
    }
  });
});

describe("createSha256", () => {
  test("matches node:crypto fed the same strings and bytes", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    const parts: (string | Uint8Array)[] = [
      "index.html",
      "\0",
      bytes,
      "\0",
      "styles.css",
      "\0",
      new Uint8Array(0),
      "\0",
      "日本語",
    ];
    const ours = createSha256();
    const node = createHash("sha256");
    for (const part of parts) {
      ours.update(part);
      node.update(part);
    }
    expect(ours.hex()).toBe(node.digest("hex"));
  });

  test("an empty hasher is the empty digest", () => {
    expect(createSha256().hex()).toBe(sha256Hex(""));
  });
});

describe("sha1Hex", () => {
  test("matches node:crypto's hex digest", () => {
    for (const text of TEXTS) {
      expect(sha1Hex(text)).toBe(createHash("sha1").update(text).digest("hex"));
    }
  });
});
