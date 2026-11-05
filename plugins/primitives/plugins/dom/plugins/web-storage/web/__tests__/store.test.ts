import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clearStorageScope,
  defineStore,
  onStorageFailure,
  removeEntriesWhere,
  storageUsage,
  type StorageFailure,
} from "../internal/store";
import { scanArea } from "../internal/scan";
import { installStorage, QuotaStorage, storageScopeOf } from "../testing";

/** The page's own scope: these suites test a store's behaviour, not scoping. */
const ROOT = storageScopeOf(null);

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
    }).in(ROOT);
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
    }).in(ROOT);
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
      // The page's own scope holds ¾ of it (1.875 KB): two entries, not three.
      cap: "2.5 KB",
      ttl: Infinity,
      whenFull: "evict-oldest",
      schema: z.string(),
    }).in(ROOT);
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
    }).in(ROOT);
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
    }).in(ROOT);
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
    }).in(ROOT);
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
    }).in(ROOT);
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
    }).in(ROOT);
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
    }).in(ROOT);
    const b = defineStore({
      owner: owner("rb"),
      label: "X",
      area: "session",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    }).in(ROOT);
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

describe("composition scopes", () => {
  const spec = (o: string) =>
    ({
      owner: o,
      label: "Drafts",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull: "refuse",
      schema: z.string(),
    }) as const;
  const demo = storageScopeOf("agent-manager-demo");

  it("keeps the page's own keys as they were and puts a PluginScope's under s:<owner>@<scope>:", () => {
    const o = owner("scoped");
    const s = defineStore(spec(o));
    s.in(ROOT).write("welcome", "desktop draft");
    s.in(demo).write("welcome", "demo draft");
    expect(JSON.parse(local.getItem(`s:${o}:welcome`)!)).toMatchObject({
      v: "desktop draft",
    });
    expect(
      JSON.parse(local.getItem(`s:${o}@agent-manager-demo:welcome`)!),
    ).toMatchObject({ v: "demo draft" });
    expect(s.in(ROOT).read("welcome")).toMatchObject({
      value: "desktop draft",
    });
    expect(s.in(demo).read("welcome")).toMatchObject({ value: "demo draft" });
    expect(s.in(ROOT).ids()).toEqual(["welcome"]);
    expect(s.in(demo).ids()).toEqual(["welcome"]);
  });

  it("reads an entry stored before scopes as the page's own", () => {
    const o = owner("pre");
    local.setItem(`s:${o}:a`, JSON.stringify({ v: "kept", ts: Date.now() }));
    const s = defineStore(spec(o));
    expect(s.in(ROOT).read("a")).toMatchObject({ value: "kept" });
    expect(s.in(demo).read("a")).toEqual({ kind: "none", why: "absent" });
  });

  it("hands back one handle per scope", () => {
    const s = defineStore(spec(owner("same")));
    expect(s.in(demo)).toBe(s.in(storageScopeOf("agent-manager-demo")));
    expect(s.in(demo)).not.toBe(s.in(ROOT));
  });

  it("counts every scope against the owner's one cap", () => {
    const s = defineStore(spec(owner("cap")));
    const big = "x".repeat(300);
    expect(s.in(ROOT).write("a", big)).toEqual({ ok: true });
    expect(s.in(demo).write("a", big)).toEqual({
      ok: false,
      reason: "over-cap",
    });
  });

  it("clearStorageScope removes one PluginScope's entries only", () => {
    const o = owner("clear");
    const s = defineStore(spec(o));
    s.in(ROOT).write("a", "page");
    s.in(demo).write("a", "demo");
    const heard: string[] = [];
    s.in(demo).subscribe("a", () => heard.push("demo"));
    clearStorageScope("agent-manager-demo");
    expect(s.in(demo).read("a")).toEqual({ kind: "none", why: "absent" });
    expect(s.in(ROOT).read("a")).toMatchObject({ value: "page" });
    expect(heard).toEqual(["demo"]);
  });

  it("a page-wide store reads and writes directly, under the page's keys", () => {
    const o = owner("page");
    const s = defineStore({ ...spec(o), pageWide: { reason: "test" } });
    s.write("a", "v");
    expect(local.getItem(`s:${o}:a`)).not.toBeNull();
  });

  it("the health scan files a scoped key under its owner", () => {
    const o = owner("scan");
    defineStore(spec(o)).in(demo).write("a", "v");
    const scan = scanArea("local");
    if (scan.kind !== "ok") throw new Error("scan unavailable");
    expect(scan.buckets.find((b) => b.id === o)?.keys).toBe(1);
  });
});

describe("eviction across scopes", () => {
  const demo = storageScopeOf("agent-manager-demo");
  const spec = (o: string, whenFull: "refuse" | "evict-oldest") =>
    ({
      owner: o,
      label: "Things",
      area: "local",
      cap: "1 KB",
      ttl: Infinity,
      whenFull,
      schema: z.string(),
    }) as const;
  const big = "x".repeat(300);

  it("a PluginScope never evicts the page's own entries", () => {
    const s = defineStore(spec(owner("ev-nested"), "evict-oldest"));
    s.in(ROOT).write("a", big);
    expect(s.in(demo).write("b", big)).toEqual({
      ok: false,
      reason: "over-cap",
    });
    expect(s.in(ROOT).read("a")).toMatchObject({ value: big });
  });

  it("the page's own write evicts a scope's entries first, even in a refuse store", () => {
    const s = defineStore(spec(owner("ev-root"), "refuse"));
    s.in(demo).write("a", big);
    expect(s.in(ROOT).write("b", big)).toEqual({ ok: true });
    expect(s.in(demo).read("a")).toEqual({ kind: "none", why: "absent" });
  });

  /** Entries small enough that several fit the 256 B reserve of a 1 KB cap. */
  const small = (i: number) => `${i}`.padEnd(40, "x");

  it("a cache's page entries leave the scopes' reserve free — a scope's write always fits", () => {
    const o = owner("ev-reserve");
    const s = defineStore(spec(o, "evict-oldest"));
    // A cache's steady state: the page wrote far more than its cap holds.
    for (let i = 0; i < 40; i++)
      expect(s.in(ROOT).write(`p${i}`, small(i))).toEqual({ ok: true });
    for (let i = 0; i < 40; i++)
      expect(s.in(demo).write(`d${i}`, small(i))).toEqual({ ok: true });
    const usage = storageUsage().find((u) => u.owner === o);
    expect(usage?.refusedOverCap).toBe(0);
    expect(usage?.bytes).toBeLessThanOrEqual(1024);
    // The page kept its newest entries; the demo evicted only its own.
    expect(s.in(ROOT).read("p39")).toMatchObject({ value: small(39) });
    expect(s.in(demo).read("d39")).toMatchObject({ value: small(39) });
    expect(s.in(demo).read("d0")).toEqual({ kind: "none", why: "absent" });
    // Writing in the page again evicts the page's own, not into the reserve.
    expect(s.in(ROOT).write("p40", small(40))).toEqual({ ok: true });
    expect(s.in(demo).read("d39")).toMatchObject({ value: small(39) });
  });

  it("a cache's page entries already in the reserve are given back on first touch", () => {
    const o = owner("ev-legacy");
    const now = Date.now();
    // Written before the reserve existed: the page holds the whole cap.
    for (let i = 0; i < 12; i++)
      local.setItem(
        `s:${o}:p${i}`,
        JSON.stringify({ v: small(i), ts: now - 1000 + i }),
      );
    const s = defineStore(spec(o, "evict-oldest"));
    expect(s.in(demo).write("d", small(0))).toEqual({ ok: true });
    expect(s.in(ROOT).read("p0")).toEqual({ kind: "none", why: "absent" });
    expect(s.in(ROOT).read("p11")).toMatchObject({ value: small(11) });
  });

  it("a refuse store keeps the reserve for its scopes too", () => {
    const s = defineStore(spec(owner("ev-refuse-reserve"), "refuse"));
    let refused = false;
    for (let i = 0; i < 40 && !refused; i++)
      refused = !s.in(ROOT).write(`p${i}`, small(i)).ok;
    expect(refused).toBe(true);
    expect(s.in(demo).write("d", small(0))).toEqual({ ok: true });
    // Rewriting a draft no bigger than it was still fits.
    expect(s.in(ROOT).write("p0", small(0))).toEqual({ ok: true });
  });

  it("a refuse store still refuses rather than evict the page's own", () => {
    const s = defineStore(spec(owner("ev-refuse"), "refuse"));
    s.in(ROOT).write("a", big);
    expect(s.in(ROOT).write("b", big)).toEqual({
      ok: false,
      reason: "over-cap",
    });
  });
});
