import { describe, expect, it } from "bun:test";
import { LIVE_ROW_KEY_MAX_BYTES, parseRowKey } from "./row-key";

class Refused extends Error {}
const refuse = (message: string): never => {
  throw new Refused(message);
};
const parse = (raw: string, arity = 2) =>
  parseRowKey(raw, arity, "after", refuse);

describe("parseRowKey", () => {
  it("parses a canonical key of the arity: text or NULL parts, then the id", () => {
    expect(parse('["2026-09-30 10:00:00.123456+00","r1"]')).toEqual([
      "2026-09-30 10:00:00.123456+00",
      "r1",
    ]);
    expect(parse('[null,"r2"]')).toEqual([null, "r2"]);
    expect(parse('["r3"]', 1)).toEqual(["r3"]);
  });

  it("refuses a wrong arity, a non-text part, a NULL id or a non-array", () => {
    expect(() => parse('["x"]')).toThrow(/row key of 2 text values/);
    expect(() => parse('["x","y","z"]')).toThrow(/row key of 2 text values/);
    expect(() => parse('["x",1]')).toThrow(/row key of 2 text values/);
    expect(() => parse('["x",null]')).toThrow(/row key of 2 text values/);
    expect(() => parse('{"a":"b"}')).toThrow(/row key of 2 text values/);
  });

  it("refuses a non-canonical spelling and invalid JSON", () => {
    expect(() => parse('["x", "r1"]')).toThrow(/not canonical/);
    expect(() => parse('["\\u0078","r1"]')).toThrow(/not canonical/);
    expect(() => parse("not json")).toThrow(/invalid JSON/);
  });

  it("refuses a key over the byte bound — none that long is minted", () => {
    // The bound is in UTF-8 bytes: a multi-byte part reaches it in fewer characters.
    const at = (part: string) => JSON.stringify([part, "r1"]);
    const fits = at("x".repeat(LIVE_ROW_KEY_MAX_BYTES - at("").length));
    expect(new TextEncoder().encode(fits).length).toBe(LIVE_ROW_KEY_MAX_BYTES);
    expect(parse(fits)).toHaveLength(2);
    // 1024 characters, 1025 bytes.
    const over = at(
      `${"x".repeat(LIVE_ROW_KEY_MAX_BYTES - at("").length - 1)}é`,
    );
    expect(over.length).toBe(LIVE_ROW_KEY_MAX_BYTES);
    expect(() => parse(over)).toThrow(/over 1024 bytes/);
  });

  it("each failure goes through the caller's onFail", () => {
    expect(() => parse("not json")).toThrow(Refused);
    expect(() => parse('["x"]')).toThrow(Refused);
  });
});
