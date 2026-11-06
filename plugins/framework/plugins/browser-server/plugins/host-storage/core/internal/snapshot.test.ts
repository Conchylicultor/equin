import { describe, expect, test } from "bun:test";
import { decodeHostSnapshot, encodeHostSnapshot } from "./snapshot";

describe("a host snapshot file", () => {
  test("round-trips the database, the facts and every store value", async () => {
    const database = new Blob([new Uint8Array([1, 2, 3, 4])], {
      type: "application/gzip",
    });
    const file = await encodeHostSnapshot({
      takenAt: 1_790_000_000_000,
      migrations: ["a", "b"],
      database,
      stores: {
        transcripts: [
          ["conv-1", { jsonl: new Uint8Array([10, 11]), version: 3 }],
        ],
        "attachment-blobs": [
          [
            "att-1",
            new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" }),
          ],
        ],
        config: [["doc", { content: { a: [1, "x", null, true] }, hash: null }]],
      },
    });
    const back = decodeHostSnapshot(file);
    expect(back.takenAt).toBe(1_790_000_000_000);
    expect(back.migrations).toEqual(["a", "b"]);
    expect(back.database.type).toBe("application/gzip");
    expect([...new Uint8Array(await back.database.arrayBuffer())]).toEqual([
      1, 2, 3, 4,
    ]);
    const [[, transcript]] = back.stores.transcripts! as [
      [string, { jsonl: Uint8Array; version: number }],
    ];
    expect(transcript.jsonl).toBeInstanceOf(Uint8Array);
    expect([...transcript.jsonl]).toEqual([10, 11]);
    expect(transcript.version).toBe(3);
    const [[, blob]] = back.stores["attachment-blobs"]! as [[string, Blob]];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([7, 8, 9]);
    expect(back.stores.config).toEqual([
      ["doc", { content: { a: [1, "x", null, true] }, hash: null }],
    ]);
  });

  test("refuses a store value that is not plain data", async () => {
    const take = encodeHostSnapshot({
      takenAt: 0,
      migrations: [],
      database: new Blob([]),
      stores: { s: [["k", { when: new Date(0) }]] },
    });
    expect(take).rejects.toThrow(/s\[k\]\.when is not plain data/);
  });

  test("refuses a file of another format", async () => {
    const file = await encodeHostSnapshot({
      takenAt: 0,
      migrations: [],
      database: new Blob([]),
      stores: {},
    });
    const length = new DataView(file.buffer).getUint32(0, true);
    const header = JSON.parse(
      new TextDecoder().decode(file.subarray(4, 4 + length)),
    ) as Record<string, unknown>;
    const other = new TextEncoder().encode(
      JSON.stringify({ ...header, format: 99 }),
    );
    const forged = new Uint8Array(4 + other.byteLength);
    new DataView(forged.buffer).setUint32(0, other.byteLength, true);
    forged.set(other, 4);
    expect(() => decodeHostSnapshot(forged)).toThrow(/format 99/);
  });
});
