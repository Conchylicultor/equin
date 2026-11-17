import { expect, test } from "bun:test";
import {
  legacyListenOf,
  parseGatewayPortRecord,
  renderGatewayPortRecord,
} from "./port-file";
import { pagePort } from "./served";

test("a port record round-trips, and only a range port with 9000 as legacy parses", () => {
  const record = { port: 8701, legacy: 9000 as const };
  expect(parseGatewayPortRecord(renderGatewayPortRecord(record), "f")).toEqual(
    record,
  );
  expect(parseGatewayPortRecord('{"port":8700,"legacy":null}', "f")).toEqual({
    port: 8700,
    legacy: null,
  });
  for (const bad of [
    '{"port":9000,"legacy":null}',
    '{"port":8710,"legacy":null}',
    '{"port":8700,"legacy":8000}',
    '{"port":8700}',
    '{"port":8700,"legacy":null,"extra":1}',
    "8700",
    "not json",
  ]) {
    expect(() => parseGatewayPortRecord(bad, "f")).toThrow(/gateway-port/);
  }
});

test("the legacy listen port is the record's, and none without one", () => {
  expect(legacyListenOf({ port: 8700, legacy: 9000 })).toBe(9000);
  expect(legacyListenOf({ port: 8700, legacy: null })).toBeNull();
  expect(legacyListenOf(null)).toBeNull();
});

test("a page's port is its own, the scheme's default when the URL has none", () => {
  expect(pagePort({ port: "8701", protocol: "http:" })).toBe(8701);
  expect(pagePort({ port: "", protocol: "https:" })).toBe(443);
  expect(pagePort({ port: "", protocol: "http:" })).toBe(80);
});
