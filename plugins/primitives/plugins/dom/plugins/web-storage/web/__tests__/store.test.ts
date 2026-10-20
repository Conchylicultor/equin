import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineStore,
  onStorageFailure,
  removeEntriesWhere,
  storageUsage,
  type StorageFailure,
} from "../internal/store";
import { scanArea } from "../internal/scan";
import { installStorage, QuotaStorage } from "../testing";

let local: QuotaStorage;
let n = 0;
/** Owners live in a module registry: every test declares fresh ones. */
const owner = (name: string) => `test.${name}-${++n}`;

beforeEach(() => {
  local = new QuotaStorage();
  installStorage("local", local);
  installStorage("session", new QuotaStorage());
});

function failures(): StorageFailure[] {
  const seen: StorageFailure[] = [];
  onStorageFailure((f) => seen.push(f));
  return seen;
}

describe("defineStore", () => {
  it("round-trips a value under s:<owner>:<id> in a {v, ts} envelope", () => {
    const o = owner("rt");
    const s = defineStore({
      owner: o,
      label: "Things",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    });
    expect(s.write("a", "hello")).toEqual({ ok: true });
    expect(JSON.parse(local.getItem(`s:${o}:a`)!)).toMatchObject({
      v: "hello",
    });
    expect(s.read("a")).toMatchObject({ kind: "value", value: "hello" });
    expect(s.read("b")).toEqual({ kind: "none", why: "absent" });
  });

  it("rejects a duplicate owner and a malformed one", () => {
    const o = owner("dup");
    const spec = {
      owner: o,
      label: "X",
      area: "local",
      cap: "1 KB",
      ttl: 1,
      whenFull: "refuse",
      schema: z.string(),
    } as const;
    defineStore(spec);
    expect(() => defineStore(spec)).toThrow(/declared twice/);
    expect(() => defineStore({ ...spec, owner: "Bad:Owner" })).toThrow(
      /must match/,
    );
  });

  it("refuses a declaration that takes the area over its budget", () => {
    expect(() =>
      defineStore({
        owner: owner("huge"),
        label: "X",
        area: "local",
        cap: "8 MB",
        ttl: 1,
        whenFull: "refuse",
        schema: z.string(),
      }),
    ).toThrow(/over the area budget/);
  });

  it("refuse: a write over the cap is not written and is announced", () => {
    const seen = failures();
    const o = owner("refuse");
    const s = defineStore({
      owner: o,
      label: "Drafts",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    });
    expect(s.write("a", "x".repeat(300)).ok).toBe(true);
    expect(s.write("b", "x".repeat(300))).toEqual({
      ok: false,
      reason: "over-cap",
    });
    expect(s.read("b").kind).toBe("none");
    expect(seen).toEqual([
      expect.objectContaining({ owner: o, reason: "over-cap" }),
    ]);
    expect(storageUsage().find((u) => u.owner === o)?.refusedOverCap).toBe(1);
  });

  it("evict-oldest: makes room by dropping the owner's oldest entries", () => {
    const o = owner("evict");
    const s = defineStore({
      owner: o,
      label: "Offsets",
      area: "local",
      cap: "2 KB",
      ttl: Infinity,
      whenFull: "evict-oldest",
      schema: z.string(),
    });
    s.write("a", "x".repeat(400));
    s.write("b", "x".repeat(400));
    expect(s.write("c", "x".repeat(400)).ok).toBe(true);
    expect(s.read("a").kind).toBe("none");
    expect(s.ids()).toEqual(["b", "c"]);
    expect(storageUsage().find((u) => u.owner === o)?.evicted).toBe(1);
  });

  it("a write the browser refuses (area full) is announced as quota", () => {
    local = new QuotaStorage(200);
    installStorage("local", local);
    local.setItem("someone-else", "x".repeat(80));
    const seen = failures();
    const o = owner("quota");
    const s = defineStore({
      owner: o,
      label: "Drafts",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    });
    expect(s.write("a", "y".repeat(50))).toEqual({
      ok: false,
      reason: "quota",
    });
    expect(seen).toEqual([
      expect.objectContaining({
        owner: o,
        reason: "quota",
        error: "QuotaExceededError",
      }),
    ]);
  });

  it("expired entries are swept on first touch", () => {
    const o = owner("ttl");
    local.setItem(
      `s:${o}:old`,
      JSON.stringify({ v: "x", ts: Date.now() - 10_000 }),
    );
    local.setItem(`s:${o}:new`, JSON.stringify({ v: "y", ts: Date.now() }));
    const s = defineStore({
      owner: o,
      label: "X",
      area: "local",
      cap: "1 KB",
      ttl: 5_000,
      whenFull: "refuse",
      schema: z.string(),
    });
    expect(s.ids()).toEqual(["new"]);
    expect(local.getItem(`s:${o}:old`)).toBeNull();
  });

  it("an entry failing the schema is dropped and reported as corrupt", () => {
    const seen = failures();
    const o = owner("corrupt");
    local.setItem(`s:${o}:a`, JSON.stringify({ v: 42, ts: Date.now() }));
    const s = defineStore({
      owner: o,
      label: "X",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    });
    expect(s.read("a")).toEqual({ kind: "none", why: "corrupt" });
    expect(local.getItem(`s:${o}:a`)).toBeNull();
    expect(seen).toEqual([
      expect.objectContaining({ owner: o, reason: "corrupt" }),
    ]);
  });

  it("legacy keys are adopted into the store, then deleted", () => {
    const o = owner("legacy");
    local.setItem("old.a", JSON.stringify("kept"));
    local.setItem("old.b", "not json");
    const s = defineStore({
      owner: o,
      label: "X",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
      legacy: {
        match: (k) => k.startsWith("old."),
        adopt: (k, raw) => {
          try {
            return {
              id: k.slice(4),
              value: JSON.parse(raw) as unknown,
              ts: Date.now(),
            };
          } catch (err) {
            if (err instanceof SyntaxError) return null;
            throw err;
          }
        },
      },
    });
    expect(s.read("a")).toMatchObject({ kind: "value", value: "kept" });
    expect(s.read("b").kind).toBe("none");
    expect(local.getItem("old.a")).toBeNull();
    expect(local.getItem("old.b")).toBeNull();
  });

  it("subscribe fires on this tab's writes and on another tab's", () => {
    const o = owner("sub");
    const s = defineStore({
      owner: o,
      label: "X",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    });
    let calls = 0;
    s.subscribe("a", () => calls++);
    s.write("a", "1");
    expect(calls).toBe(1);
    const raw = JSON.stringify({ v: "2", ts: Date.now() });
    local.setItem(`s:${o}:a`, raw);
    // jsdom's StorageEvent only takes its own Storage class as storageArea.
    const event = new StorageEvent("storage", {
      key: `s:${o}:a`,
      newValue: raw,
    });
    Object.defineProperty(event, "storageArea", { value: local });
    window.dispatchEvent(event);
    expect(calls).toBe(2);
    expect(s.read("a")).toMatchObject({ value: "2" });
  });

  it("removeEntriesWhere removes matching ids across owners", () => {
    const a = defineStore({
      owner: owner("ra"),
      label: "X",
      area: "session",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    });
    const b = defineStore({
      owner: owner("rb"),
      label: "X",
      area: "session",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    });
    a.write("t1:old", "x");
    b.write("t1:old", "y");
    b.write("t1:new", "z");
    removeEntriesWhere("session", (id) => id.endsWith(":old"));
    expect(a.ids()).toEqual([]);
    expect(b.ids()).toEqual(["t1:new"]);
  });
});

describe("scanArea", () => {
  it("groups keys by owner, legacy and unowned", () => {
    const o = owner("scan");
    defineStore({
      owner: o,
      label: "X",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
      legacy: { match: (k) => k === "ancient" },
    });
    local.setItem(`s:${o}:a`, JSON.stringify({ v: "x", ts: 1 }));
    local.setItem("ancient", "1");
    local.setItem("frimousse/data/en", "x".repeat(100));
    const scan = scanArea("local");
    if (scan.kind !== "ok") throw new Error("unavailable");
    const byId = new Map(scan.buckets.map((b) => [b.id, b]));
    expect(byId.get(o)?.keys).toBe(1);
    expect(byId.get(`legacy:${o}`)?.keys).toBe(1);
    expect(byId.get("unowned")?.largest[0]?.key).toBe("frimousse/data/en");
  });
});
