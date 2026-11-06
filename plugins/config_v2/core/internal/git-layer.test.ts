import { describe, expect, test } from "bun:test";
import {
  computeHash,
  loadedProxy,
  readonlyProxy,
  type ConfigProxy,
} from "./config-proxy";
import {
  committedDocument,
  committedFilesFromMap,
  committedFilesIn,
  propagateGitLayerDocument,
  resolveGitLayer,
} from "./git-layer";
import { createMemoryConfigStore } from "./memory-store";
import type { JsonValue } from "./types";
import { proxyFiles } from "../testing";

function file(content: JsonValue, hash: string | null): ConfigProxy {
  return loadedProxy({ content, hash });
}
const absent: ConfigProxy = loadedProxy(null);

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

  test("seeds a memory store's origins like a fresh user's", async () => {
    const store = createMemoryConfigStore({
      propagatedFrom: (sp) => (sp === "p/config.jsonc" ? doc : undefined),
    });
    expect(
      await store.read({ storePath: "p/config.jsonc", file: "origin" }),
    ).toEqual({ content: doc.base, hash: computeHash(doc.base) });
    expect(
      await store.read({
        storePath: "p/config.jsonc",
        scopeId: "app:pages",
        file: "origin",
      }),
    ).toEqual({
      content: doc.scopes.pages,
      hash: computeHash(doc.scopes.pages),
    });
    expect(
      await store.read({ storePath: "p/config.jsonc", file: "override" }),
    ).toBeNull();
    expect(await store.scopes("p/config.jsonc")).toEqual(["app:pages"]);
    expect(
      await store.read({ storePath: "r/config.jsonc", file: "origin" }),
    ).toBeNull();
  });

  test("seeds once: a write survives later touches", async () => {
    const store = createMemoryConfigStore({ propagatedFrom: () => doc });
    const ref = { storePath: "p/config.jsonc", file: "origin" } as const;
    await store.write(ref, { a: 3 }, "h");
    await store.stamp(ref);
    expect((await store.read(ref))?.content).toEqual({ a: 3 });
  });

  test("reports a user override written against another upstream", () => {
    const proxyOf = proxyFiles();
    const sp = "p/config.jsonc";
    proxyOf({ storePath: sp, file: "override" }).write({ a: 5 }, "stale");
    expect(propagateGitLayerDocument(sp, doc, proxyOf).conflicts).toEqual([
      { storePath: sp },
    ]);
  });
});

describe("committedFilesIn", () => {
  // A dir on a stubbed fs: the reader's paths, not a real disk.
  const files = new Map<string, string>([
    ["/c/top.jsonc", "T"],
    ["/c/a/b/config.origin.jsonc", "O"],
    ["/c/a/b/@app/home/config.jsonc", "H"],
  ]);
  const dirs = new Map<string, string[]>([
    ["/c/@app", ["pages"]],
    ["/c/a/b/@app", ["home"]],
  ]);
  const read = committedFilesIn("/c", {
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => files.get(p)!,
    readdirSync: (p) =>
      (dirs.get(p) ?? []).map((name) => ({ name, isDirectory: () => true })),
  });

  test("reads a file by its layout path, null when absent", () => {
    expect(read.read({ storePath: "top.jsonc", file: "override" })).toBe("T");
    expect(read.read({ storePath: "a/b/config.jsonc", file: "origin" })).toBe(
      "O",
    );
    expect(read.read({ storePath: "a/b/config.jsonc", file: "override" })).toBe(
      null,
    );
    expect(
      read.read({
        storePath: "a/b/config.jsonc",
        scopeId: "app:home",
        file: "override",
      }),
    ).toBe("H");
  });

  test("lists the app scopes under a nested and a top-level hierarchy", () => {
    expect(read.appIds("a/b/config.jsonc")).toEqual(["home"]);
    expect(read.appIds("top.jsonc")).toEqual(["pages"]);
    expect(read.appIds("x/config.jsonc")).toEqual([]);
  });
});
