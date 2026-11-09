import { describe, expect, test } from "bun:test";
import { createMemoryConfigStore, type MemoryConfigDoc } from "./memory-store";
import { configFileRelPath, parseConfigFileRelPath } from "./store";

const base = { storePath: "a/b/config.jsonc" };
const scoped = { storePath: "a/b/config.jsonc", scopeId: "app:pages" };

describe("createMemoryConfigStore", () => {
  test("one file per { storePath, scopeId, file }", async () => {
    const store = createMemoryConfigStore();
    await store.write({ ...base, file: "override" }, { v: 1 }, "h");
    expect(await store.read({ ...base, file: "override" })).toEqual({
      content: { v: 1 },
      hash: "h",
    });
    expect(await store.read({ ...base, file: "origin" })).toBeNull();
    expect(await store.read({ ...scoped, file: "override" })).toBeNull();
    expect(
      await store.read({ ...base, scopeId: "", file: "override" }),
    ).not.toBeNull();
  });

  test("a stamp is '-' when absent and moves on every write", async () => {
    const store = createMemoryConfigStore();
    const ref = { ...base, file: "override" } as const;
    expect(await store.stamp(ref)).toBe("-");
    await store.write(ref, { v: 1 }, "h");
    const first = await store.stamp(ref);
    await store.write(ref, { v: 1 }, "h");
    expect(await store.stamp(ref)).not.toBe(first);
    await store.remove(ref);
    expect(await store.stamp(ref)).toBe("-");
    expect(await store.read(ref)).toBeNull();
  });

  test("scopes lists the scopes holding a document under the hierarchy", async () => {
    const store = createMemoryConfigStore();
    await store.write({ ...scoped, file: "origin" }, {}, "h");
    await store.write(
      { storePath: "a/b/other.jsonc", scopeId: "app:mail", file: "override" },
      {},
      "h",
    );
    await store.write(
      { storePath: "c/config.jsonc", scopeId: "app:x", file: "override" },
      {},
      "h",
    );
    expect(await store.scopes(base.storePath)).toEqual([
      "app:mail",
      "app:pages",
    ]);
  });

  test("a scope whose last document is removed is no longer listed", async () => {
    const store = createMemoryConfigStore();
    await store.write({ ...scoped, file: "origin" }, {}, "h");
    await store.write({ ...scoped, file: "override" }, {}, "h");
    await store.remove({ ...scoped, file: "origin" });
    expect(await store.scopes(base.storePath)).toEqual(["app:pages"]);
    await store.remove({ ...scoped, file: "override" });
    expect(await store.scopes(base.storePath)).toEqual([]);
  });

  test("scopes lists what a persisted layer held when it was read back", async () => {
    const kept = new Map<string, MemoryConfigDoc>();
    const persist = () => ({
      loaded: kept,
      put: (key: string, doc: MemoryConfigDoc) => void kept.set(key, doc),
      delete: (key: string) => void kept.delete(key),
    });
    const first = createMemoryConfigStore({ persist });
    await first.write({ ...scoped, file: "override" }, {}, "h");
    const reopened = createMemoryConfigStore({ persist });
    expect(await reopened.scopes(base.storePath)).toEqual(["app:pages"]);
  });

  test("edit runs the mutation and returns its result", async () => {
    const store = createMemoryConfigStore();
    expect(
      await store.edit(base, { kind: "user" }, "op", () => Promise.resolve(7)),
    ).toBe(7);
  });
});

describe("configFileRelPath", () => {
  test("the user-layer layout of each file", () => {
    expect(configFileRelPath({ ...base, file: "origin" })).toBe(
      "a/b/config.origin.jsonc",
    );
    expect(configFileRelPath({ ...base, file: "override" })).toBe(
      "a/b/config.jsonc",
    );
    expect(configFileRelPath({ ...scoped, file: "ancestor" })).toBe(
      "a/b/@app/pages/config.ancestor.jsonc",
    );
  });
});

describe("parseConfigFileRelPath", () => {
  test("round-trips configFileRelPath for every file of base and scoped documents", () => {
    for (const ref of [
      { ...base, file: "origin" as const },
      { ...base, file: "override" as const },
      { ...base, file: "ancestor" as const },
      { ...scoped, file: "origin" as const },
      { ...scoped, file: "override" as const },
      { ...scoped, file: "ancestor" as const },
    ]) {
      expect(parseConfigFileRelPath(configFileRelPath(ref))).toEqual(ref);
    }
  });

  test("a path outside the layout throws", () => {
    for (const rel of [
      "a/b/config.json",
      "config.jsonc",
      "a/@app/x/@app/y/config.jsonc",
      "a/b/.jsonc",
    ]) {
      expect(() => parseConfigFileRelPath(rel)).toThrow(/Not a config file/);
    }
  });
});
