import { afterEach, describe, expect, test } from "bun:test";
import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { LOOPBACK_BIND, listenFlag, resolveListenAddress } from "./listen";

describe("resolveListenAddress", () => {
  const saved = readEnv("LISTEN");
  afterEach(() => {
    if (saved === undefined) unsetEnv("LISTEN");
    else setEnv("LISTEN", saved);
  });

  function resolveWith(value: string | undefined, manifestPort = 9000) {
    if (value === undefined) unsetEnv("LISTEN");
    else setEnv("LISTEN", value);
    return resolveListenAddress(manifestPort);
  }

  test("unset is loopback on the manifest port, never a wildcard", () => {
    expect(resolveWith(undefined)).toEqual({ host: LOOPBACK_BIND, port: 9000 });
    expect(resolveWith("  ", 9100)).toEqual({
      host: LOOPBACK_BIND,
      port: 9100,
    });
    expect(listenFlag(resolveWith(undefined))).toBe("loopback:9000");
  });

  test("an explicit ':P' is the wildcard opt-in", () => {
    expect(resolveWith(":9100")).toEqual({ host: null, port: 9100 });
    expect(listenFlag(resolveWith(":9100"))).toBe(":9100");
  });

  test("explicit hosts pass through verbatim", () => {
    expect(resolveWith("127.0.0.1:9100")).toEqual({
      host: "127.0.0.1",
      port: 9100,
    });
    expect(resolveWith("[::1]:9100")).toEqual({ host: "[::1]", port: 9100 });
    expect(resolveWith("loopback:9100")).toEqual({
      host: LOOPBACK_BIND,
      port: 9100,
    });
    expect(listenFlag(resolveWith("[::1]:9100"))).toBe("[::1]:9100");
  });

  test("malformed input throws instead of falling back", () => {
    expect(() => resolveWith("9100")).toThrow(/not a host:port address/);
    expect(() => resolveWith("127.0.0.1:")).toThrow(/Invalid listen port/);
    expect(() => resolveWith(":abc")).toThrow(/Invalid listen port/);
    expect(() => resolveWith(":70000")).toThrow(/Invalid listen port/);
  });

  test("a bad manifest port throws", () => {
    expect(() => resolveWith(undefined, 0)).toThrow(/RELEASE.json/);
  });
});
