import { describe, expect, test } from "bun:test";
import {
  OPEN_RANGE_CHUNK_BYTES,
  parseRange,
  rangedBlobResponse,
} from "./byte-range";

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

  test("an open end is bounded when asked; an explicit end as asked", () => {
    const size = 16 * 1024 * 1024;
    const cap = OPEN_RANGE_CHUNK_BYTES;
    expect(parseRange("bytes=0-", size, cap)).toEqual({
      kind: "range",
      range: { start: 0, end: cap - 1 },
    });
    expect(parseRange("bytes=5000000-", size, cap)).toEqual({
      kind: "range",
      range: { start: 5000000, end: 5000000 + cap - 1 },
    });
    // The last chunk ends at the body's end.
    expect(parseRange(`bytes=${size - 10}-`, size, cap)).toEqual({
      kind: "range",
      range: { start: size - 10, end: size - 1 },
    });
    expect(parseRange(`bytes=0-${size - 1}`, size, cap)).toEqual({
      kind: "range",
      range: { start: 0, end: size - 1 },
    });
  });
});

describe("rangedBlobResponse", () => {
  const body = new Blob(["0123456789"], { type: "video/mp4" });
  const headers = { "content-type": "video/mp4" };

  test("no Range: the whole body, ranges advertised", async () => {
    const res = rangedBlobResponse(body, new Headers(), headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("0123456789");
  });

  test("one range: 206 with exactly those bytes", async () => {
    const res = rangedBlobResponse(
      body,
      new Headers({ range: "bytes=2-5" }),
      headers,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  const big = new Blob([new Uint8Array(3 * OPEN_RANGE_CHUNK_BYTES)]);
  const total = 3 * OPEN_RANGE_CHUNK_BYTES;

  test("a media element's open end: 206 with one chunk, the total named", async () => {
    for (const dest of ["video", "audio"]) {
      const res = rangedBlobResponse(
        big,
        new Headers({ range: "bytes=0-", "sec-fetch-dest": dest }),
        headers,
      );
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(
        `bytes 0-${OPEN_RANGE_CHUNK_BYTES - 1}/${total}`,
      );
      expect((await res.arrayBuffer()).byteLength).toBe(OPEN_RANGE_CHUNK_BYTES);
    }
  });

  test("any other open end (a resumed download, curl): the rest, whole", async () => {
    for (const extra of [{}, { "sec-fetch-dest": "document" }] as Record<
      string,
      string
    >[]) {
      const res = rangedBlobResponse(
        big,
        new Headers({ range: "bytes=1024-", ...extra }),
        headers,
      );
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(
        `bytes 1024-${total - 1}/${total}`,
      );
    }
  });

  test("past the end: 416 naming the size", () => {
    const res = rangedBlobResponse(
      body,
      new Headers({ range: "bytes=10-" }),
      headers,
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });
});
