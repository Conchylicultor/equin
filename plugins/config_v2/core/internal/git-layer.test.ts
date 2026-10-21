import { describe, expect, test } from "bun:test";
import { computeHash, readonlyProxy, type ConfigProxy } from "./config-proxy";
import { resolveGitLayer } from "./git-layer";
import { createMemoryConfigStore } from "./store";
import type { JsonValue } from "./types";

function file(content: JsonValue, hash: string | null): ConfigProxy {
  const store = createMemoryConfigStore();
  const p = store.proxy({ storePath: "x", file: "override" });
  p.write(content, hash);
  return p;
}
const absent: ConfigProxy = createMemoryConfigStore().proxy({
  storePath: "absent",
  file: "override",
});

const ORIGIN = { a: 1, b: "x" };
const origin = file(ORIGIN, computeHash(ORIGIN));

describe("resolveGitLayer", () => {
  test("an override anchored to the current origin wins", () => {
    const override = file({ a: 2, b: "x" }, computeHash(ORIGIN));
    expect(resolveGitLayer(origin, override, new Map())).toEqual({
      base: { a: 2, b: "x" },
      scopes: {},
    });
  });

  test("a stale override loses to its origin", () => {
    const override = file({ a: 2, b: "x" }, "000000000000");
    expect(resolveGitLayer(origin, override, new Map())?.base).toEqual(ORIGIN);
  });

  test("an @app scope is its delta over the base; an absent delta is no scope", () => {
    const override = file({ a: 2, b: "x" }, computeHash(ORIGIN));
    const doc = resolveGitLayer(
      origin,
      override,
      new Map([
        ["pages", file({ b: "y" }, computeHash(ORIGIN))],
        ["mail", absent],
      ]),
    );
    expect(doc?.scopes).toEqual({ pages: { a: 2, b: "y" } });
  });

  test("no origin and no override is no document", () => {
    expect(resolveGitLayer(absent, absent, new Map())).toBeUndefined();
  });

  test("an override with no origin stands", () => {
    expect(
      resolveGitLayer(absent, readonlyProxy({ a: 3 }), new Map())?.base,
    ).toEqual({ a: 3 });
  });
});
