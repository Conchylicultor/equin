import { describe, expect, test } from "bun:test";
import { buildSnapshot, loadSnapshot, lookupIn } from "./snapshot";

const CSV = [
  "0.0.0.0,0.255.255.255,ZZ",
  "1.0.0.0,1.0.0.255,AU",
  "1.0.1.0,1.0.3.255,CN",
  // gap: 1.0.4.0 – 1.255.255.255
  "2.0.0.0,2.255.255.255,FR",
  "255.255.255.0,255.255.255.255,US",
  "::,1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff,ZZ",
  "2001::,2001:0:ffff:ffff:ffff:ffff:ffff:ffff,US",
  // gap: 2001:1:: – 2a00::
  "2a00::,2a00:ffff:ffff:ffff:ffff:ffff:ffff:ffff,FR",
  "fec0::,ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff,CH",
  "",
].join("\n");

async function snapshot() {
  return loadSnapshot(await buildSnapshot(CSV, 202609));
}

describe("snapshot", () => {
  test("round-trips its header", async () => {
    const s = await snapshot();
    expect(s.sourceMonth).toBe(202609);
    expect(s.v4Start.length).toBe(5);
    expect(s.v6StartHi.length).toBe(4);
    expect([...s.codes].sort()).toEqual(["AU", "CH", "CN", "FR", "US", "ZZ"]);
  });

  test("IPv4: first, middle and last address of a range", async () => {
    const s = await snapshot();
    for (const ip of ["1.0.1.0", "1.0.2.77", "1.0.3.255"]) {
      expect(lookupIn(s, ip)).toEqual({ kind: "found", country: "CN" });
    }
    expect(lookupIn(s, "1.0.0.255")).toEqual({ kind: "found", country: "AU" });
    expect(lookupIn(s, "255.255.255.255")).toEqual({
      kind: "found",
      country: "US",
    });
    expect(lookupIn(s, "::ffff:2.3.4.5")).toEqual({
      kind: "found",
      country: "FR",
    });
  });

  test("IPv6: range edges", async () => {
    const s = await snapshot();
    expect(lookupIn(s, "2001::")).toEqual({ kind: "found", country: "US" });
    expect(lookupIn(s, "2001:0:ffff:ffff:ffff:ffff:ffff:ffff")).toEqual({
      kind: "found",
      country: "US",
    });
    expect(lookupIn(s, "2a00:1450::1")).toEqual({
      kind: "found",
      country: "FR",
    });
    expect(lookupIn(s, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toEqual({
      kind: "found",
      country: "CH",
    });
  });

  test("gaps, ZZ and non-addresses are unlisted", async () => {
    const s = await snapshot();
    for (const ip of [
      "1.0.4.0",
      "1.200.0.0",
      "0.1.2.3",
      "::1",
      "2001:1::",
      "fe80::1",
      "nope",
    ]) {
      expect({ ip, r: lookupIn(s, ip) }).toEqual({
        ip,
        r: { kind: "unlisted" },
      });
    }
  });

  test("an empty family is unlisted, not an error", async () => {
    const s = loadSnapshot(
      await buildSnapshot("1.0.0.0,1.0.0.255,AU\n", 202609),
    );
    expect(lookupIn(s, "2001::1")).toEqual({ kind: "unlisted" });
    expect(lookupIn(s, "0.0.0.1")).toEqual({ kind: "unlisted" });
  });

  test("loads from bytes not on an 8-byte boundary", async () => {
    const bytes = await buildSnapshot(CSV, 202609);
    const shifted = new Uint8Array(bytes.byteLength + 3);
    shifted.set(bytes, 3);
    const s = loadSnapshot(shifted.subarray(3));
    expect(lookupIn(s, "2.1.1.1")).toEqual({ kind: "found", country: "FR" });
  });

  test("out-of-order or overlapping rows throw, naming the row", async () => {
    const cases: [string, RegExp][] = [
      ["2.0.0.0,2.0.0.255,FR\n1.0.0.0,1.0.0.255,AU\n", /line 2/],
      ["1.0.0.0,1.0.0.255,AU\n1.0.0.255,1.0.1.0,CN\n", /overlapping/],
      ["2a00::,2a00::ff,FR\n2001::,2001::ff,US\n", /out of order/],
      ["1.0.0.9,1.0.0.1,AU\n", /end before start/],
      ["1.0.0.0,::1,AU\n", /one family/],
      ["1.0.0.0,1.0.0.1\n", /start,end,CC/],
    ];
    for (const [csv, message] of cases) {
      expect(buildSnapshot(csv, 202609)).rejects.toThrow(message);
    }
  });

  test("a wrong magic, version or length throws on load", async () => {
    const bytes = await buildSnapshot(CSV, 202609);
    const badMagic = bytes.slice();
    badMagic[0] = 0;
    expect(() => loadSnapshot(badMagic)).toThrow(/bad magic/);
    const badVersion = bytes.slice();
    badVersion[4] = 99;
    expect(() => loadSnapshot(badVersion)).toThrow(/format 99/);
    expect(() => loadSnapshot(bytes.slice(0, bytes.byteLength - 1))).toThrow(
      /header implies/,
    );
    expect(() => loadSnapshot(new Uint8Array(3))).toThrow(/shorter/);
  });
});
