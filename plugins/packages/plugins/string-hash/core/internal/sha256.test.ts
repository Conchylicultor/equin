import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  test("matches node:crypto's hex digest", () => {
    for (const text of [
      "",
      "a",
      "hello world",
      "CREATE OR REPLACE VIEW tasks_v AS SELECT 1",
      "unicode ✓ — é ü 日本語 🎵",
      "x".repeat(10_000),
    ]) {
      expect(sha256Hex(text)).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
    }
  });
});
