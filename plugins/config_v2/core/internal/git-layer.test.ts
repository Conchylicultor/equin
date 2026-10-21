import { describe, expect, test } from "bun:test";
import { computeHash, readonlyProxy, type ConfigProxy } from "./config-proxy";
import {
  committedDocument,
  committedFilesFromMap,
  propagateGitLayerDocument,
  resolveGitLayer,
} from "./git-layer";
import { createMemoryConfigStore } from "./memory-store";
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

describe("committedDocument", () => {
  const raw = (content: JsonValue, hash: string) =>
    `// @hash ${hash}\n${JSON.stringify(content)}\n`;
  const BASE_HASH = computeHash(ORIGIN);
  const files = committedFilesFromMap(
    new Map([
      ["p/config.origin.jsonc", raw(ORIGIN, BASE_HASH)],
      ["p/config.jsonc", raw({ a: 2, b: "x" }, BASE_HASH)],
      ["p/@app/pages/config.jsonc", raw({ b: "y" }, BASE_HASH)],
      ["p/@app/mail/other.jsonc", raw({ z: 1 }, BASE_HASH)],
      ["q/config.origin.jsonc", raw(ORIGIN, BASE_HASH)],
      ["q/config.jsonc", raw({ a: 9, b: "x" }, "000000000000")],
    ]),
  );

  test("override ⊕ origin, each committed @app delta over that base", () => {
    expect(committedDocument("p/config.jsonc", files)).toEqual({
      base: { a: 2, b: "x" },
      scopes: { pages: { a: 2, b: "y" } },
    });
  });

  test("a stale override loses to its origin", () => {
    expect(committedDocument("q/config.jsonc", files)?.base).toEqual(ORIGIN);
  });

  test("nothing committed is no document", () => {
    expect(committedDocument("r/config.jsonc", files)).toBeUndefined();
  });

  test("a hashless committed file throws, naming it", () => {
    const bad = committedFilesFromMap(new Map([["p/x.origin.jsonc", "{}"]]));
    expect(() => committedDocument("p/x.jsonc", bad)).toThrow(
      /p\/x\.origin\.jsonc/,
    );
  });
});

describe("propagateGitLayerDocument", () => {
  const doc = { base: { a: 2, b: "x" }, scopes: { pages: { a: 2, b: "y" } } };

  test("seeds a memory store's origins like a fresh user's", () => {
    const store = createMemoryConfigStore({
      propagatedFrom: (sp) => (sp === "p/config.jsonc" ? doc : undefined),
    });
    expect(
      store.proxy({ storePath: "p/config.jsonc", file: "origin" }).read(),
    ).toEqual({ content: doc.base, hash: computeHash(doc.base) });
    expect(
      store
        .proxy({
          storePath: "p/config.jsonc",
          scopeId: "app:pages",
          file: "origin",
        })
        .read(),
    ).toEqual({
      content: doc.scopes.pages,
      hash: computeHash(doc.scopes.pages),
    });
    expect(
      store.proxy({ storePath: "p/config.jsonc", file: "override" }).exists(),
    ).toBe(false);
    expect(store.scopes("p/config.jsonc")).toEqual(["app:pages"]);
    expect(
      store.proxy({ storePath: "r/config.jsonc", file: "origin" }).exists(),
    ).toBe(false);
  });

  test("seeds once: a write survives later touches", () => {
    const store = createMemoryConfigStore({ propagatedFrom: () => doc });
    const ref = { storePath: "p/config.jsonc", file: "origin" } as const;
    store.proxy(ref).write({ a: 3 }, "h");
    store.stamp(ref);
    expect(store.proxy(ref).read()?.content).toEqual({ a: 3 });
  });

  test("reports a user override written against another upstream", () => {
    const store = createMemoryConfigStore();
    const sp = "p/config.jsonc";
    store.proxy({ storePath: sp, file: "override" }).write({ a: 5 }, "stale");
    const proxyOf = (ref: Parameters<typeof store.proxy>[0]) =>
      store.proxy(ref);
    expect(propagateGitLayerDocument(sp, doc, proxyOf).conflicts).toEqual([
      { storePath: sp },
    ]);
  });
});
