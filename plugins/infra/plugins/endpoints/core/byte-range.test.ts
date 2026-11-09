import { describe, expect, test } from "bun:test";
import { parseRange, rangedBlobResponse } from "./byte-range";

describe("parseRange", () => {
  test("reads one bytes range, serves anything else whole", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-9", 100)).toEqual({
      kind: "range",
      range: { start: 0, end: 9 },
    });
    expect(parseRange("bytes=90-", 100)).toEqual({
      kind: "range",
      range: { start: 90, end: 99 },
    });
    expect(parseRange("bytes=90-500", 100)).toEqual({
      kind: "range",
      range: { start: 90, end: 99 },
    });
    expect(parseRange("bytes=-10", 100)).toEqual({
      kind: "range",
      range: { start: 90, end: 99 },
    });
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "none" });
    expect(parseRange("items=0-1", 100)).toEqual({ kind: "none" });
  });
});

describe("rangedBlobResponse", () => {
  const body = new Blob(["0123456789"], { type: "video/mp4" });
  const headers = { "content-type": "video/mp4" };

  test("no Range: the whole body, ranges advertised", async () => {
    const res = rangedBlobResponse(body, null, headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("0123456789");
  });

  test("one range: 206 with exactly those bytes", async () => {
    const res = rangedBlobResponse(body, "bytes=2-5", headers);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  test("past the end: 416 naming the size", () => {
    const res = rangedBlobResponse(body, "bytes=10-", headers);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });
});
