import { describe, expect, test } from "bun:test";
import { formatByteSize, parseByteSize } from "./format";

describe("formatByteSize", () => {
  test.each([
    [0, "0 B"],
    [840, "840 B"],
    [999.6, "1.0 kB"],
    [1000, "1.0 kB"],
    [18_400, "18.4 kB"],
    [84_200_000, "84.2 MB"],
    [512_000_000, "512 MB"],
    [999_960_000, "1.0 GB"],
    [1_500_000_000, "1.5 GB"],
    [2_500_000_000, "2.5 GB"],
    [3e18, "3000 PB"],
    [-1500, "-1.5 kB"],
  ])("%p bytes → %p", (bytes, text) => {
    expect(formatByteSize(bytes)).toBe(text);
  });

  test("a non-finite size throws", () => {
    expect(() => formatByteSize(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("parseByteSize", () => {
  test.each([
    ["1 GB", 1e9],
    ["500kB", 500_000],
    ["500 KB", 500_000],
    ["1.5gb", 1_500_000_000],
    ["12 B", 12],
    ["4 GiB", 4 * 1024 ** 3],
    ["2m", 2_000_000],
    ["1234", 1234],
    [" 84.2 MB ", 84_200_000],
  ])("%p → %p bytes", (text, bytes) => {
    expect(parseByteSize(text)).toBe(bytes);
  });

  test.each(["", "GB", "1 XB", "1 GB 2 MB", "-1 GB", "1,5 GB"])(
    "%p is not a size",
    (text) => {
      expect(parseByteSize(text)).toBeNull();
    },
  );

  test("a formatted size parses back to its shown value", () => {
    expect(parseByteSize(formatByteSize(18_400))).toBe(18_400);
    expect(parseByteSize(formatByteSize(1_500_000_000))).toBe(1_500_000_000);
  });
});
