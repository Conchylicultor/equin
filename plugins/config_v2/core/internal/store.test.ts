import { describe, expect, test } from "bun:test";
import { configFileRelPath, createMemoryConfigStore } from "./store";

const base = { storePath: "a/b/config.jsonc" };
const scoped = { storePath: "a/b/config.jsonc", scopeId: "app:pages" };

describe("createMemoryConfigStore", () => {
  test("one file per { storePath, scopeId, file }", () => {
    const store = createMemoryConfigStore();
    store.proxy({ ...base, file: "override" }).write({ v: 1 }, "h");
    expect(store.proxy({ ...base, file: "override" }).read()).toEqual({
      content: { v: 1 },
      hash: "h",
    });
    expect(store.proxy({ ...base, file: "origin" }).exists()).toBe(false);
    expect(store.proxy({ ...scoped, file: "override" }).exists()).toBe(false);
    expect(
      store.proxy({ ...base, scopeId: "", file: "override" }).exists(),
    ).toBe(true);
  });

  test("a stamp is '-' when absent and moves on every write", () => {
    const store = createMemoryConfigStore();
    const ref = { ...base, file: "override" } as const;
    expect(store.stamp(ref)).toBe("-");
    store.proxy(ref).write({ v: 1 }, "h");
    const first = store.stamp(ref);
    store.proxy(ref).write({ v: 1 }, "h");
    expect(store.stamp(ref)).not.toBe(first);
    store.remove(ref);
    expect(store.stamp(ref)).toBe("-");
    expect(store.proxy(ref).exists()).toBe(false);
  });

  test("scopes lists the scopes holding a document under the hierarchy", () => {
    const store = createMemoryConfigStore();
    store.proxy({ ...scoped, file: "origin" }).write({}, "h");
    store
      .proxy({
        storePath: "a/b/other.jsonc",
        scopeId: "app:mail",
        file: "override",
      })
      .write({}, "h");
    store
      .proxy({
        storePath: "c/config.jsonc",
        scopeId: "app:x",
        file: "override",
      })
      .write({}, "h");
    expect(store.scopes(base.storePath)).toEqual(["app:mail", "app:pages"]);
  });

  test("edit runs the mutation and returns its result", () => {
    const store = createMemoryConfigStore();
    expect(store.edit(base, { kind: "user" }, "op", () => 7)).toBe(7);
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
