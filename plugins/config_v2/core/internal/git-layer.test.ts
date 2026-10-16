import { describe, expect, test } from "bun:test";
import { computeHash, readonlyProxy, type ConfigProxy } from "./config-proxy";
import { resolveGitLayer } from "./git-layer";
import { createMemoryConfigStore } from "./memory-config-store";
import type { JsonValue } from "./types";

function file(content: JsonValue, hash: string | null): ConfigProxy {
  const store = createMemoryConfigStore();
  const p = store.proxy("x");
  p.write(content, hash);
  return p;
}
const absent: ConfigProxy = createMemoryConfigStore().proxy("absent");

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

describe("createMemoryConfigStore", () => {
  test("one document per { path, scopeId }", () => {
    const store = createMemoryConfigStore();
    store.proxy("p").write({ v: 1 }, "h");
    expect(store.proxy("p").read()).toEqual({ content: { v: 1 }, hash: "h" });
    expect(store.proxy("p", "app:x").exists()).toBe(false);
    expect(store.proxy("q").read()).toBeNull();
  });
});
