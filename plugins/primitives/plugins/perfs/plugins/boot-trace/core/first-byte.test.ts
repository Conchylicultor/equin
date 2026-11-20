import { describe, expect, test } from "bun:test";
import { firstByteSplit, type NavigationTimingFields } from "./first-byte";

const COLD: NavigationTimingFields = {
  fetchStart: 5,
  domainLookupStart: 6,
  domainLookupEnd: 56,
  connectStart: 56,
  secureConnectionStart: 156,
  connectEnd: 256,
  requestStart: 258,
  responseStart: 400,
  nextHopProtocol: "h2",
};

describe("firstByteSplit", () => {
  test("a cold connection splits into DNS, TCP, TLS and the wait, adding up", () => {
    const s = firstByteSplit(COLD);
    expect(s).toEqual({
      totalMs: 400,
      beforeFetchMs: 5,
      dnsMs: 50,
      tcpMs: 100,
      tlsMs: 100,
      waitMs: 142,
      otherMs: 3,
      protocol: "h2",
    });
  });

  test("a redirect before the fetch shows as beforeFetchMs", () => {
    const shift = 900;
    const s = firstByteSplit({
      ...COLD,
      fetchStart: COLD.fetchStart + shift,
      domainLookupStart: COLD.domainLookupStart + shift,
      domainLookupEnd: COLD.domainLookupEnd + shift,
      connectStart: COLD.connectStart + shift,
      secureConnectionStart: COLD.secureConnectionStart + shift,
      connectEnd: COLD.connectEnd + shift,
      requestStart: COLD.requestStart + shift,
      responseStart: COLD.responseStart + shift,
    });
    expect(s?.beforeFetchMs).toBe(905);
    expect(s?.totalMs).toBe(1300);
    expect(s?.waitMs).toBe(142);
  });

  test("a reused connection has no DNS, TCP or TLS", () => {
    const s = firstByteSplit({
      ...COLD,
      domainLookupStart: 5,
      domainLookupEnd: 5,
      connectStart: 5,
      secureConnectionStart: 0,
      connectEnd: 5,
      requestStart: 6,
      responseStart: 80,
      nextHopProtocol: "",
    });
    expect(s).toMatchObject({
      dnsMs: 0,
      tcpMs: 0,
      tlsMs: 0,
      waitMs: 74,
      protocol: null,
    });
  });

  test("no first byte yet is null", () => {
    expect(firstByteSplit({ ...COLD, responseStart: 0 })).toBeNull();
  });

  test("an h3 handshake is all TLS (QUIC), never TCP", () => {
    const s = firstByteSplit({ ...COLD, nextHopProtocol: "h3" });
    expect(s).toMatchObject({ tcpMs: 0, tlsMs: 200, protocol: "h3" });
  });

  test("no protocol from the browser is null", () => {
    const { nextHopProtocol: _, ...rest } = COLD;
    expect(firstByteSplit(rest)?.protocol).toBeNull();
  });

  test("out-of-order instants never make a part negative or overrun the total", () => {
    const s = firstByteSplit({
      ...COLD,
      secureConnectionStart: 3, // before connectStart (a reused-connection quirk)
      requestStart: 900, // past the first byte
    })!;
    const parts =
      s.beforeFetchMs + s.dnsMs + s.tcpMs + s.tlsMs + s.waitMs + s.otherMs;
    expect(parts).toBe(s.totalMs);
    for (const v of [s.dnsMs, s.tcpMs, s.tlsMs, s.waitMs, s.otherMs])
      expect(v).toBeGreaterThanOrEqual(0);
    expect(s.waitMs).toBe(0);
  });
});
