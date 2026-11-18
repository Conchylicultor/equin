import { describe, expect, test } from "bun:test";
import { signatureMatches, signatureOf } from "./signature";

const body = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');

describe("delivery signature", () => {
  test("matches the HMAC of the raw body under the same secret", () => {
    expect(signatureMatches("s3cret", body, signatureOf("s3cret", body))).toBe(
      true,
    );
  });

  test("GitHub's documented example", () => {
    // docs.github.com — "Validating webhook deliveries", test values.
    const payload = new TextEncoder().encode("Hello, World!");
    expect(
      signatureMatches(
        "It's a Secret to Everybody",
        payload,
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).toBe(true);
  });

  test("refuses another secret, another body, a missing or malformed header", () => {
    const sig = signatureOf("s3cret", body);
    expect(signatureMatches("other", body, sig)).toBe(false);
    expect(
      signatureMatches("s3cret", new TextEncoder().encode("{}"), sig),
    ).toBe(false);
    expect(signatureMatches("s3cret", body, null)).toBe(false);
    expect(signatureMatches("s3cret", body, sig.slice(7))).toBe(false);
    expect(signatureMatches("s3cret", body, "sha256=abcd")).toBe(false);
    expect(signatureMatches("s3cret", body, "sha256=zz")).toBe(false);
  });
});
