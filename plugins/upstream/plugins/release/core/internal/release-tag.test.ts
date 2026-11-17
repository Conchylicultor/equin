import { describe, expect, test } from "bun:test";
import {
  compareReleases,
  newestReleaseTag,
  nextReleaseTag,
  parseReleaseTag,
  releaseTags,
  releaseVersion,
} from "./release-tag";

describe("parseReleaseTag", () => {
  test("a day's release, and a later one the same day", () => {
    expect(parseReleaseTag("v2026.11.14")).toEqual({
      kind: "release",
      release: { tag: "v2026.11.14", year: 2026, month: 11, day: 14, seq: 1 },
    });
    expect(parseReleaseTag("v2026.11.14.2")).toMatchObject({
      kind: "release",
      release: { seq: 2 },
    });
  });

  test("other tags are not releases", () => {
    for (const t of [
      "v1",
      "v1.2.3",
      "nightly",
      "2026.11.14",
      "v2026.13.01",
      "v2026.11.00",
      "v2026.11.14.1",
      "v2026.11.14-rc",
    ])
      expect(parseReleaseTag(t)).toEqual({ kind: "other" });
  });
});

describe("ordering", () => {
  test("by date, then by the day's sequence", () => {
    const sorted = releaseTags([
      "v2026.11.14.2",
      "nightly",
      "v2026.10.30",
      "v2026.11.14.10",
      "v2026.11.14",
    ]).map((r) => r.tag);
    expect(sorted).toEqual([
      "v2026.10.30",
      "v2026.11.14",
      "v2026.11.14.2",
      "v2026.11.14.10",
    ]);
  });

  test("compareReleases is negative for the older one", () => {
    const a = releaseTags(["v2025.12.31"])[0]!;
    const b = releaseTags(["v2026.01.01"])[0]!;
    expect(compareReleases(a, b)).toBeLessThan(0);
  });

  test("the newest, or none", () => {
    expect(newestReleaseTag(["v2026.10.30", "v2026.11.14"])).toEqual({
      kind: "release",
      tag: "v2026.11.14",
    });
    expect(newestReleaseTag(["v1", "nightly"])).toEqual({ kind: "none" });
  });
});

describe("nextReleaseTag", () => {
  const now = new Date("2026-11-17T23:30:00Z");

  test("the UTC date, on a fresh day", () => {
    expect(nextReleaseTag(now, ["v2026.11.14"])).toBe("v2026.11.17");
  });

  test("a second and third release the same day", () => {
    expect(nextReleaseTag(now, ["v2026.11.17"])).toBe("v2026.11.17.2");
    expect(nextReleaseTag(now, ["v2026.11.17", "v2026.11.17.2"])).toBe(
      "v2026.11.17.3",
    );
  });

  test("UTC, not local time", () => {
    // 23:30 UTC on the 17th is already the 18th east of UTC; the name must not
    // depend on where the author's laptop is.
    expect(nextReleaseTag(new Date("2026-11-18T00:10:00Z"), [])).toBe(
      "v2026.11.18",
    );
  });
});

test("releaseVersion drops the prefix", () => {
  expect(releaseVersion("v2026.11.14.2")).toBe("2026.11.14.2");
});
