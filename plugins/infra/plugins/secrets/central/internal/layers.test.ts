import { describe, expect, test } from "bun:test";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { SECRET_HISTORY_LIMIT } from "@plugins/infra/plugins/secrets/core";
import {
  applyWrite,
  emptyBlob,
  InstanceWriteRefusedError,
  listKeys,
  metadataOf,
  readValue,
  upgradeBlob,
  type Access,
} from "./layers";
import { resolveScope, ScopeMismatchError } from "./legacy-scope";

const main: Access = { scope: "instance", caller: MAIN_WORKTREE_NAME };
const wt: Access = { scope: "instance", caller: "att-1-abc" };
const film: Access = { scope: "instance", caller: `promo-film.att-1-abc` };
const anon: Access = { scope: "instance", caller: null };
const NS = "deploy-secrets";

describe("instance namespaces", () => {
  test("main writes the base; every caller reads it through", () => {
    const blob = emptyBlob();
    applyWrite(blob, main, NS, "K", "real", 1);
    expect(blob.namespaces[NS]?.K?.value).toBe("real");
    expect(readValue(blob, main, NS, "K")).toBe("real");
    expect(readValue(blob, wt, NS, "K")).toBe("real");
    expect(readValue(blob, anon, NS, "K")).toBe("real");
  });

  test("a worktree's write lands in its overlay; main still reads the base", () => {
    const blob = emptyBlob();
    applyWrite(blob, main, NS, "K", "real", 1);
    applyWrite(blob, film, NS, "K", "fake", 2);
    expect(readValue(blob, film, NS, "K")).toBe("fake");
    expect(readValue(blob, main, NS, "K")).toBe("real");
    expect(readValue(blob, wt, NS, "K")).toBe("real");
    expect(metadataOf(blob, main, NS, "K").updatedAt).toBe(1);
  });

  test("a composition namespace on main's checkout is not main", () => {
    const blob = emptyBlob();
    applyWrite(
      blob,
      { scope: "instance", caller: "promo-film" },
      NS,
      "K",
      "x",
      1,
    );
    expect(blob.namespaces[NS]).toBeUndefined();
    expect(readValue(blob, main, NS, "K")).toBeUndefined();
  });

  test("a worktree's delete tombstones its overlay; main's value stays and does not reappear", () => {
    const blob = emptyBlob();
    applyWrite(blob, main, NS, "K", "real", 1);
    expect(applyWrite(blob, wt, NS, "K", null, 2)).toBe(true);
    expect(readValue(blob, wt, NS, "K")).toBeUndefined();
    expect(metadataOf(blob, wt, NS, "K").set).toBe(false);
    expect(listKeys(blob, wt, NS)).toEqual([]);
    expect(readValue(blob, main, NS, "K")).toBe("real");
    expect(listKeys(blob, main, NS)).toEqual(["K"]);
  });

  test("deleting what the caller does not see is no write", () => {
    const blob = emptyBlob();
    expect(applyWrite(blob, wt, NS, "K", null, 1)).toBe(false);
    expect(blob.overlays).toEqual({});
  });

  test("an unidentified caller may not write an instance namespace", () => {
    const blob = emptyBlob();
    expect(() => applyWrite(blob, anon, NS, "K", "x", 1)).toThrow(
      InstanceWriteRefusedError,
    );
    expect(() => applyWrite(blob, anon, NS, "K", null, 1)).toThrow(
      InstanceWriteRefusedError,
    );
    expect(blob).toEqual(emptyBlob());
  });

  test("a listing merges the base and the caller's overlay", () => {
    const blob = emptyBlob();
    applyWrite(blob, main, NS, "A", "a", 1);
    applyWrite(blob, main, NS, "B", "b", 1);
    applyWrite(blob, wt, NS, "C", "c", 2);
    applyWrite(blob, wt, NS, "A", null, 2);
    expect(listKeys(blob, wt, NS).sort()).toEqual(["B", "C"]);
    expect(listKeys(blob, main, NS).sort()).toEqual(["A", "B"]);
    expect(listKeys(blob, anon, NS).sort()).toEqual(["A", "B"]);
  });
});

describe("machine namespaces", () => {
  test("one value for every caller, an unidentified one included", () => {
    const blob = emptyBlob();
    const ns = "config-fields";
    applyWrite(
      blob,
      { scope: "machine", caller: "att-1-abc" },
      ns,
      "K",
      "v1",
      1,
    );
    applyWrite(blob, { scope: "machine", caller: null }, ns, "K", "v2", 2);
    for (const caller of [MAIN_WORKTREE_NAME, "att-2-def", null]) {
      expect(readValue(blob, { scope: "machine", caller }, ns, "K")).toBe("v2");
    }
    expect(blob.overlays).toEqual({});
  });
});

describe("history", () => {
  test("records who, when and whether the value changed — never the value", () => {
    const blob = emptyBlob();
    applyWrite(blob, main, NS, "K", "a", 1);
    applyWrite(blob, main, NS, "K", "a", 2);
    applyWrite(blob, main, NS, "K", "b", 3);
    applyWrite(blob, main, NS, "K", null, 4);
    const { history, set } = metadataOf(blob, main, NS, "K");
    expect(set).toBe(false);
    expect(history).toEqual([
      { at: 1, op: "set", by: MAIN_WORKTREE_NAME, changed: true },
      { at: 2, op: "set", by: MAIN_WORKTREE_NAME, changed: false },
      { at: 3, op: "set", by: MAIN_WORKTREE_NAME, changed: true },
      { at: 4, op: "delete", by: MAIN_WORKTREE_NAME, changed: true },
    ]);
    expect(JSON.stringify(history)).not.toContain('"a"');
  });

  test("an overlay's first write compares with the base value it shadows", () => {
    const blob = emptyBlob();
    applyWrite(blob, main, NS, "K", "same", 1);
    applyWrite(blob, wt, NS, "K", "same", 2);
    expect(metadataOf(blob, wt, NS, "K").history).toEqual([
      { at: 2, op: "set", by: "att-1-abc", changed: false },
    ]);
    expect(metadataOf(blob, main, NS, "K").history).toHaveLength(1);
  });

  test(`keeps the last ${SECRET_HISTORY_LIMIT} writes`, () => {
    const blob = emptyBlob();
    for (let i = 0; i < SECRET_HISTORY_LIMIT + 5; i++) {
      applyWrite(blob, main, NS, "K", `v${i}`, i);
    }
    const { history } = metadataOf(blob, main, NS, "K");
    expect(history).toHaveLength(SECRET_HISTORY_LIMIT);
    expect(history[0]?.at).toBe(5);
    expect(history.at(-1)?.at).toBe(SECRET_HISTORY_LIMIT + 4);
  });
});

describe("upgradeBlob", () => {
  test("a v1 blob becomes the base with empty histories and no overlays", () => {
    const v1 = {
      version: 1,
      namespaces: { "deploy-secrets": { K: { value: "real", updatedAt: 7 } } },
    };
    const blob = upgradeBlob(v1);
    expect(blob).toEqual({
      version: 2,
      namespaces: {
        "deploy-secrets": { K: { value: "real", updatedAt: 7, history: [] } },
      },
      overlays: {},
    });
    expect(metadataOf(blob, wt, NS, "K")).toEqual({
      set: true,
      updatedAt: 7,
      history: [],
    });
  });

  test("a v2 blob reads back as itself", () => {
    const blob = emptyBlob();
    applyWrite(blob, wt, NS, "K", "x", 1);
    expect(upgradeBlob(JSON.parse(JSON.stringify(blob)))).toEqual(blob);
  });

  test("any other shape throws", () => {
    expect(() => upgradeBlob({ version: 3, namespaces: {} })).toThrow(
      /unexpected shape/,
    );
    expect(() => upgradeBlob(null)).toThrow(/unexpected shape/);
  });
});

describe("resolveScope", () => {
  test("a sent scope wins; a pre-scope caller's is read from the closed record", () => {
    expect(resolveScope("config-fields", "instance")).toBe("instance");
    expect(resolveScope("deploy-ssh", undefined)).toBe("instance");
    expect(resolveScope("auth-tokens", undefined)).toBe("machine");
  });

  test("a known instance namespace cannot be claimed as machine", () => {
    expect(() => resolveScope("deploy-secrets", "machine")).toThrow(
      ScopeMismatchError,
    );
    expect(resolveScope("deploy-secrets", "instance")).toBe("instance");
  });
});
