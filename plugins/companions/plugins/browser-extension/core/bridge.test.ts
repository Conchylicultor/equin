import { describe, expect, test } from "bun:test";
import {
  acceptBridgePort,
  BRIDGE_PORT,
  BRIDGE_RESULTS,
  BridgeRequestSchema,
  BridgeResponseSchema,
  ExtensionHostInfoSchema,
} from "./bridge";
import { EXTENSION_ORIGIN } from "./extension-id";

const parent = { name: "parent" };
const port = { name: "port" };

function message(over: Partial<Parameters<typeof acceptBridgePort>[0]> = {}) {
  return {
    origin: EXTENSION_ORIGIN,
    source: parent,
    data: BRIDGE_PORT,
    ports: [port],
    ...over,
  };
}

describe("acceptBridgePort", () => {
  test("takes the port the extension's popup hands over", () => {
    expect(acceptBridgePort(message(), parent)).toBe(port);
  });

  test("refuses a foreign origin", () => {
    expect(
      acceptBridgePort(message({ origin: "https://evil.example" }), parent),
    ).toBeNull();
    expect(
      acceptBridgePort(
        message({
          origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
        parent,
      ),
    ).toBeNull();
  });

  test("refuses a message from another window than the parent", () => {
    expect(acceptBridgePort(message({ source: {} }), parent)).toBeNull();
  });

  test("refuses another shape, or not exactly one port", () => {
    expect(
      acceptBridgePort(message({ data: { type: "other" } }), parent),
    ).toBeNull();
    expect(acceptBridgePort(message({ ports: [] }), parent)).toBeNull();
    expect(
      acceptBridgePort(message({ ports: [port, port] }), parent),
    ).toBeNull();
  });
});

describe("bridge schemas", () => {
  test("parse a request by method, refusing bad params", () => {
    expect(
      BridgeRequestSchema.parse({
        id: 1,
        method: "navigate",
        params: { url: "http://equin.localhost:9000/about" },
      }),
    ).toEqual({
      id: 1,
      method: "navigate",
      params: { url: "http://equin.localhost:9000/about" },
    });
    expect(
      BridgeRequestSchema.safeParse({
        id: 1,
        method: "navigate",
        params: { url: "not a url" },
      }).success,
    ).toBe(false);
    expect(
      BridgeRequestSchema.safeParse({ id: 1, method: "eval", params: {} })
        .success,
    ).toBe(false);
  });

  test("parse a response and the host's info", () => {
    expect(
      BridgeResponseSchema.parse({ id: 2, ok: false, error: "nope" }),
    ).toEqual({ id: 2, ok: false, error: "nope" });
    const info = {
      version: 1 as const,
      shellDigest: "abc",
      capabilities: {
        activeTab: true,
        navigate: true,
        openTab: true,
        close: true,
        badge: true,
      },
    };
    expect(ExtensionHostInfoSchema.parse(info)).toEqual(info);
    expect(
      BRIDGE_RESULTS.hostInfo.safeParse({ ...info, version: 2 }).success,
    ).toBe(false);
  });
});
