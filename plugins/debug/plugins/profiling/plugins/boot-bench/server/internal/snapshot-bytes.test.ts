import { describe, expect, it } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { measureSnapshotBytes } from "./snapshot-bytes";

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

describe("measureSnapshotBytes", () => {
  const snap = {
    resources: {
      // A window whose rows carry the row key, one of them null (over-long).
      notifications: [
        { id: "n1", title: "é", $key: '["2026","n1"]' },
        { id: "n2", title: "b", $key: null },
      ],
      // A window without row keys, and a plain value.
      "build.history": [{ id: "b1" }],
      settings: { theme: "dark" },
    },
    tuples: {
      config: [
        { params: { path: "a" }, value: [{ k: 1, $key: '["a"]' }] },
        { params: { path: "b" }, value: { k: 2 } },
      ],
    },
    timings: { settings: { source: "loader" as const, workMs: 1 } },
    persistedReadMs: 3,
  };
  const bytes = measureSnapshotBytes(snap);

  it("measures the whole body as the endpoint serializes it", () => {
    expect(bytes.total.raw).toBe(utf8(JSON.stringify(snap)));
    expect(bytes.total.gzip).toBeGreaterThan(0);
    expect(bytes.total.gzip).toBeLessThan(bytes.total.raw);
  });

  it("measures each key's own value, raw in UTF-8 bytes", () => {
    expect(bytes.perKey.notifications!.raw).toBe(
      utf8(JSON.stringify(snap.resources.notifications)),
    );
    expect(bytes.perKey.settings!.raw).toBe(utf8('{"theme":"dark"}'));
    // An enumerated key is its `{ params, value }[]`.
    expect(bytes.perKey.config!.raw).toBe(
      utf8(JSON.stringify(snap.tuples.config)),
    );
    expect(Object.keys(bytes.perKey).sort()).toEqual([
      "build.history",
      "config",
      "notifications",
      "settings",
    ]);
  });

  it("gzips at a size that round-trips to the raw bytes", () => {
    // Sanity on the compressor wiring: the gzip of a key decompresses back.
    const json = JSON.stringify(snap.resources.notifications);
    const z = gzipSync(Buffer.from(json), { level: 6 });
    expect(z.byteLength).toBe(bytes.perKey.notifications!.gzip);
    expect(gunzipSync(z).toString()).toBe(json);
  });

  it("reports the mean bytes the row key adds to a row, only where rows carry one", () => {
    const a = utf8(`,"$key":${JSON.stringify('["2026","n1"]')}`);
    const b = utf8(`,"$key":null`);
    expect(bytes.rowKeyBytes.notifications).toBe((a + b) / 2);
    // Every enumerated tuple's rows count; a non-array value has none.
    expect(bytes.rowKeyBytes.config).toBe(
      utf8(`,"$key":${JSON.stringify('["a"]')}`),
    );
    expect(bytes.rowKeyBytes["build.history"]).toBeUndefined();
    expect(bytes.rowKeyBytes.settings).toBeUndefined();
  });
});
