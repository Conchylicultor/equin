import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { pruneCacheDir, surveyCacheDir } from "./store";
import {
  refreshServedDists,
  scanServedDists,
  servedDistTargets,
} from "./served-dists";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function fixture() {
  const base = asAppPath(mkdtempSync(join(tmpdir(), "served-dists-")));
  const store = joinAppPath(base, "store");
  const worktrees = joinAppPath(base, "worktrees");
  const layout = { worktrees, memoDir: joinAppPath(base, "dist-links") };
  mkdirSync(store, { recursive: true });
  // A served dist: ns/web -> ns/web.live.1, linking store entries.
  const live = joinAppPath(worktrees, "ns", "web.live.1");
  mkdirSync(joinAppPath(live, "artifacts"), { recursive: true });
  symlinkSync("web.live.1", joinAppPath(worktrees, "ns", "web"));
  const entry = (name: string, ageMs: number): AppPath => {
    const p = joinAppPath(store, name);
    mkdirSync(p);
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
    return p;
  };
  const link = (name: string, target: AppPath): void =>
    symlinkSync(target, joinAppPath(live, "artifacts", name));
  return { store, worktrees, layout, entry, link };
}

describe("servedDistTargets", () => {
  test("collects link targets once across web and web.live.*", () => {
    const f = fixture();
    const a = f.entry("a", 0);
    f.link("a", a);
    expect([...servedDistTargets(f.layout)]).toEqual([a]);
  });

  test("releases sharing one address dir read it once, through their links", () => {
    const f = fixture();
    const a = f.entry("a", 0);
    const b = f.entry("b", 0);
    const ns = joinAppPath(f.worktrees, "ns2");
    const addresses = joinAppPath(ns, "web-addresses");
    mkdirSync(addresses, { recursive: true });
    symlinkSync(a, joinAppPath(addresses, "a"));
    symlinkSync(b, joinAppPath(addresses, "b"));
    for (const rel of ["web.live.1", "web.staging.2"]) {
      mkdirSync(joinAppPath(ns, rel), { recursive: true });
      symlinkSync(addresses, joinAppPath(ns, rel, "artifacts"));
    }
    symlinkSync("web.live.1", joinAppPath(ns, "web"));
    const scan = scanServedDists(f.layout);
    expect([...scan.targets].sort()).toEqual([a, b].sort());
    // ns/web.live.1's empty artifacts/ + ns2's one address dir.
    expect(scan.linksRead).toBe(2);
  });

  test("no worktrees dir yields nothing", () => {
    expect(
      servedDistTargets({
        worktrees: asAppPath(join(tmpdir(), "no-such-dir-xyz")),
        memoDir: asAppPath(join(tmpdir(), "no-such-dir-xyz-memo")),
      }).size,
    ).toBe(0);
  });
});

describe("a dist's links are read once, then memoized", () => {
  test("a second scan reads no links and finds the same targets", () => {
    const f = fixture();
    const a = f.entry("a", 0);
    f.link("a", a);
    const first = scanServedDists(f.layout);
    expect(first.linksRead).toBe(1);
    const second = scanServedDists(f.layout);
    expect(second.linksRead).toBe(0);
    expect([...second.targets]).toEqual([a]);
  });

  test("a link added since the memo invalidates it", () => {
    const f = fixture();
    const a = f.entry("a", 0);
    f.link("a", a);
    scanServedDists(f.layout);
    const b = f.entry("b", 0);
    f.link("b", b);
    const scan = scanServedDists(f.layout);
    expect(scan.linksRead).toBe(1);
    expect(new Set(scan.targets)).toEqual(new Set([a, b]));
  });

  test("a link removed since the memo is no longer a root", () => {
    const f = fixture();
    const a = f.entry("a", 0);
    const b = f.entry("b", 0);
    f.link("a", a);
    f.link("b", b);
    scanServedDists(f.layout);
    rmSync(joinAppPath(f.worktrees, "ns", "web.live.1", "artifacts", "b"));
    expect([...scanServedDists(f.layout).targets]).toEqual([a]);
  });

  test("a worker tree's own links are memoized with the dist", () => {
    const f = fixture();
    const inner = f.entry("inner", 0);
    const tree = f.entry("worker-tree.0123456789abcdef", 0);
    symlinkSync(inner, joinAppPath(tree, "inner"));
    f.link("worker-tree.0123456789abcdef", tree);
    scanServedDists(f.layout);
    const scan = scanServedDists(f.layout);
    expect(scan.linksRead).toBe(0);
    expect(new Set(scan.targets)).toEqual(new Set([tree, inner]));
  });

  test("a dist linking a missing worker tree is not memoized", () => {
    const f = fixture();
    const tree = joinAppPath(f.store, "worker-tree.fedcba9876543210");
    f.link("worker-tree.fedcba9876543210", tree); // not published (yet)
    scanServedDists(f.layout);
    // Published again at the same address: the dist's stamp does not move.
    mkdirSync(tree);
    const inner = f.entry("inner", 0);
    symlinkSync(inner, joinAppPath(tree, "inner"));
    const scan = scanServedDists(f.layout);
    expect(scan.linksRead).toBe(1);
    expect(scan.targets.has(inner)).toBe(true);
  });

  test("the memo of a dist that is gone is deleted", () => {
    const f = fixture();
    const other = joinAppPath(f.worktrees, "ns2", "web.live.2");
    mkdirSync(joinAppPath(other, "artifacts"), { recursive: true });
    symlinkSync(f.entry("c", 0), joinAppPath(other, "artifacts", "c"));
    scanServedDists(f.layout);
    expect(readdirSync(f.layout.memoDir)).toHaveLength(2);
    rmSync(joinAppPath(f.worktrees, "ns2"), { recursive: true });
    scanServedDists(f.layout);
    expect(readdirSync(f.layout.memoDir)).toHaveLength(1);
  });
});

describe("pruneCacheDir keeps entries a served dist links", () => {
  test("a referenced old entry survives the age-out; unreferenced goes", () => {
    const f = fixture();
    const kept = f.entry("kept", 30 * DAY);
    const gone = f.entry("gone", 30 * DAY);
    f.link("kept", kept);
    pruneCacheDir({
      root: f.store,
      maxAgeMs: 14 * DAY,
      maxUnreferenced: 100,
      trimTo: 50,
      referenced: servedDistTargets(f.layout),
    });
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  test("a prune removes at most its budget, oldest first; the rest wait", () => {
    const f = fixture();
    const aged = [40, 35, 30, 25].map((d) => f.entry(`a${d}`, d * DAY));
    const removed = pruneCacheDir({
      root: f.store,
      maxAgeMs: 14 * DAY,
      maxUnreferenced: 100,
      trimTo: 50,
      referenced: servedDistTargets(f.layout),
      maxRemovals: 2,
    });
    expect(removed).toBe(2);
    expect(aged.map((p) => existsSync(p))).toEqual([false, false, true, true]);
  });

  test("a referenced oldest entry survives the count trim", () => {
    const f = fixture();
    const oldest = f.entry("e0", 5 * DAY);
    f.link("e0", oldest);
    // Older than the snapshot margin (1 min): judged by the count trim.
    const others = [1, 2, 3, 4, 5].map((i) =>
      f.entry(`e${i}`, (5 - i) * 1000 + 2 * MINUTE),
    );
    pruneCacheDir({
      root: f.store,
      maxAgeMs: 14 * DAY,
      maxUnreferenced: 4,
      trimTo: 3,
      referenced: servedDistTargets(f.layout),
    });
    expect(existsSync(oldest)).toBe(true);
    // 5 unreferenced > 4, trimmed to 3: the 2 oldest unreferenced go.
    expect(others.map((p) => existsSync(p))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  test("an entry younger than the margin counts toward the cap but is never trimmed", () => {
    const f = fixture();
    const old = [0, 1].map((i) => f.entry(`old${i}`, (3 + i) * MINUTE));
    // Published by a build that holds no lease (older code) while the prune
    // walked: no root can speak for them.
    const fresh = [0, 1].map((i) => f.entry(`fresh${i}`, i * 1000));
    pruneCacheDir({
      root: f.store,
      maxAgeMs: 14 * DAY,
      maxUnreferenced: 2,
      trimTo: 1,
      referenced: servedDistTargets(f.layout),
    });
    expect(fresh.every((p) => existsSync(p))).toBe(true);
    expect(old.some((p) => existsSync(p))).toBe(false);
  });

  test("referenced entries beyond the cap are all kept, and do not count toward it", () => {
    const f = fixture();
    const refs = [0, 1, 2, 3].map((i) => {
      const p = f.entry(`r${i}`, (i + 1) * 1000);
      f.link(`r${i}`, p);
      return p;
    });
    // Roots alone exceed the cap; the two unreferenced entries are within it.
    const spares = [f.entry("spare0", 2000), f.entry("spare1", 0)];
    pruneCacheDir({
      root: f.store,
      maxAgeMs: 14 * DAY,
      maxUnreferenced: 2,
      trimTo: 1,
      referenced: servedDistTargets(f.layout),
    });
    expect(refs.every((p) => existsSync(p))).toBe(true);
    expect(spares.map((p) => existsSync(p))).toEqual([true, true]);
  });

  test("past the cap, unreferenced entries trim oldest-first to trimTo", () => {
    const f = fixture();
    const ref = f.entry("ref", 9000);
    f.link("ref", ref);
    const spares = [3, 2, 1].map((i) =>
      f.entry(`s${i}`, i * 1000 + 2 * MINUTE),
    );
    pruneCacheDir({
      root: f.store,
      maxAgeMs: 14 * DAY,
      maxUnreferenced: 2,
      trimTo: 1,
      referenced: servedDistTargets(f.layout),
    });
    expect(existsSync(ref)).toBe(true);
    expect(spares.map((p) => existsSync(p))).toEqual([false, false, true]);
  });
});

describe("refreshServedDists re-reads only what changed since the scan", () => {
  test("a link added after the scan is a root after the refresh", () => {
    const f = fixture();
    const a = f.entry("a", 0);
    f.link("a", a);
    const scan = scanServedDists(f.layout);
    const b = f.entry("b", 0);
    f.link("b", b);
    expect(scan.targets.has(b)).toBe(false);
    expect(refreshServedDists(scan, f.layout).reread).toBe(1);
    expect(scan.targets.has(b)).toBe(true);
  });

  test("a dist published after the scan is read; unchanged ones are not", () => {
    const f = fixture();
    const scan = scanServedDists(f.layout);
    const c = f.entry("c", 0);
    const other = joinAppPath(f.worktrees, "ns2", "web.live.2");
    mkdirSync(joinAppPath(other, "artifacts"), { recursive: true });
    symlinkSync(c, joinAppPath(other, "artifacts", "c"));
    expect(refreshServedDists(scan, f.layout).reread).toBe(1);
    expect(scan.targets.has(c)).toBe(true);
    expect(refreshServedDists(scan, f.layout).reread).toBe(0);
  });
});

describe("pruneCacheDir over an unlocked survey", () => {
  const policy = (store: AppPath) => ({
    root: store,
    maxAgeMs: 14 * DAY,
    maxUnreferenced: 0,
    trimTo: 0,
  });

  test("an entry reused since the survey is kept; one published since is not judged", () => {
    const f = fixture();
    const reused = f.entry("reused", 20 * DAY);
    const idle = f.entry("idle", 20 * DAY);
    const survey = surveyCacheDir(f.store, new Set());
    const now = new Date();
    utimesSync(reused, now, now); // touchArtifact
    const fresh = f.entry("fresh", 2 * MINUTE);
    const removed = pruneCacheDir({
      ...policy(f.store),
      referenced: new Set(),
      survey,
    });
    expect(removed).toBe(1);
    expect(existsSync(idle)).toBe(false);
    expect(existsSync(reused)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  test("an entry that became a root after the survey is kept", () => {
    const f = fixture();
    const linked = f.entry("linked", 20 * DAY);
    const survey = surveyCacheDir(f.store, new Set());
    f.link("linked", linked);
    pruneCacheDir({
      ...policy(f.store),
      referenced: servedDistTargets(f.layout),
      survey,
    });
    expect(existsSync(linked)).toBe(true);
  });
});
