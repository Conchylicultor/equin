import { describe, expect, test } from "bun:test";
import { siteReportRecordOfRow } from "./site-row";

// A row as the box's change stream carries it: to_jsonb text under UTC.
const row = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    fingerprint: "crash:abc",
    kind: "crash",
    source: "browser-error",
    message: "boom",
    data: { stack: "Error: boom" },
    path: "/pricing",
    build_id: null,
    commit: "0123456789abcdef",
    count: 3,
    first_seen_at: "2026-11-12T01:00:00.5+00:00",
    last_seen_at: "2026-11-12T03:00:00+00:00",
    ...over,
  });

describe("siteReportRecordOfRow", () => {
  test("a mirrored row becomes the intake's record, instants in ISO UTC", () => {
    expect(siteReportRecordOfRow(row())).toEqual({
      fingerprint: "crash:abc",
      kind: "crash",
      source: "browser-error",
      message: "boom",
      data: { stack: "Error: boom" },
      path: "/pricing",
      buildId: null,
      commit: "0123456789abcdef",
      count: 3,
      firstSeenAt: "2026-11-12T01:00:00.500Z",
      lastSeenAt: "2026-11-12T03:00:00.000Z",
    });
  });

  test("a column a newer box adds is dropped unread", () => {
    expect(
      siteReportRecordOfRow(row({ visitor_ip: "1.2.3.4" })),
    ).not.toHaveProperty("visitor_ip");
  });

  test("a row that does not parse throws", () => {
    expect(() => siteReportRecordOfRow(row({ count: "3" }))).toThrow();
    expect(() => siteReportRecordOfRow(row({ data: "x" }))).toThrow();
    expect(() =>
      siteReportRecordOfRow(row({ last_seen_at: "soon" })),
    ).toThrow();
    expect(() => siteReportRecordOfRow("not json")).toThrow();
  });
});
