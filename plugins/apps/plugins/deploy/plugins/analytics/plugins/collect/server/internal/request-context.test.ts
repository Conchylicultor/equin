import { describe, expect, test } from "bun:test";
import {
  identityNetwork,
  parseReferrer,
  primaryLanguage,
  visitorHash,
} from "./request-context";

describe("primaryLanguage", () => {
  test("first entry's primary subtag, lowercased", () => {
    expect(primaryLanguage("fr-CH, fr;q=0.9, en;q=0.8")).toBe("fr");
    expect(primaryLanguage("EN-us")).toBe("en");
  });
  test("absent or wildcard is null", () => {
    expect(primaryLanguage(null)).toBeNull();
    expect(primaryLanguage("*")).toBeNull();
  });
});

describe("parseReferrer", () => {
  test("host normalised, path kept, query dropped", () => {
    expect(
      parseReferrer("https://www.GitHub.com/a/b?tab=readme#x", "equin.dev"),
    ).toEqual({ host: "github.com", path: "/a/b" });
  });
  test("self-referral is no referrer", () => {
    expect(parseReferrer("https://equin.dev/story", "equin.dev")).toBeNull();
    expect(
      parseReferrer("http://localhost:9000/x", "localhost:9000"),
    ).toBeNull();
  });
  test("empty or not a URL is no referrer", () => {
    expect(parseReferrer("", "equin.dev")).toBeNull();
    expect(parseReferrer("not a url", "equin.dev")).toBeNull();
  });
});

describe("visitorHash", () => {
  const parts = {
    salt: "s",
    ip: "203.0.113.7",
    userAgent: "ua",
    host: "equin.dev",
  };
  test("stable for the same inputs, different for a new salt", () => {
    expect(visitorHash(parts)).toBe(visitorHash(parts));
    expect(visitorHash({ ...parts, salt: "t" })).not.toBe(visitorHash(parts));
  });
  test("field boundaries cannot be shifted", () => {
    expect(visitorHash({ ...parts, ip: "10.0.0.1", userAgent: "2ua" })).not.toBe(
      visitorHash({ ...parts, ip: "10.0.0.12", userAgent: "ua" }),
    );
  });
});

describe("identityNetwork", () => {
  test("an IPv4 address is its own network, mapped or not", () => {
    expect(identityNetwork("203.0.113.7")).toBe("203.0.113.7");
    expect(identityNetwork("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
  test("an IPv6 address is cut to its /64, however it is spelled", () => {
    expect(identityNetwork("2001:db8:a:b:1111:2222:3333:4444")).toBe(
      "2001:db8:a:b::/64",
    );
    expect(identityNetwork("2001:0DB8:000a:000b::1")).toBe("2001:db8:a:b::/64");
    expect(identityNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(identityNetwork("[fe80::1%en0]")).toBe("fe80:0:0:0::/64");
  });
  test("anything else is refused", () => {
    expect(() => identityNetwork("not-an-ip")).toThrow(/not an IP address/);
    expect(() => identityNetwork("1:2:3:4:5:6:7:8:9")).toThrow();
    expect(() => identityNetwork("1::2::3")).toThrow();
  });
});

describe("visitorHash on IPv6", () => {
  const at = (ip: string) =>
    visitorHash({ salt: "s", ip, userAgent: "ua", host: "equin.dev" });
  test("a phone rotating its temporary address keeps one hash", () => {
    expect(at("2001:db8:a:b:1111:2222:3333:4444")).toBe(
      at("2001:db8:a:b:9999:8888:7777:6666"),
    );
  });
  test("another network is another hash", () => {
    expect(at("2001:db8:a:b::1")).not.toBe(at("2001:db8:a:c::1"));
  });
});
