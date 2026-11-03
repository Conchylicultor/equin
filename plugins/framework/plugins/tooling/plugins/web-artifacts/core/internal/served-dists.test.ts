import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  return { store, worktrees, entry, link };
}

describe("servedDistTargets", () => {
  test("collects link targets once across web and web.live.*", () => {
    const f = fixture();
    const a = f.entry("a", 0);
    f.link("a", a);
    expect([...servedDistTargets(f.worktrees)]).toEqual([a]);
  });

  test("no worktrees dir yields nothing", () => {
    expect(
      servedDistTargets(asAppPath(join(tmpdir(), "no-such-dir-xyz"))).size,
    ).toBe(0);
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
      referenced: servedDistTargets(f.worktrees),
    });
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(gone)).toBe(false);
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
      referenced: servedDistTargets(f.worktrees),
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
      referenced: servedDistTargets(f.worktrees),
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
      referenced: servedDistTargets(f.worktrees),
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
      referenced: servedDistTargets(f.worktrees),
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
    const scan = scanServedDists(f.worktrees);
    const b = f.entry("b", 0);
    f.link("b", b);
    expect(scan.targets.has(b)).toBe(false);
    expect(refreshServedDists(scan, f.worktrees).reread).toBe(1);
    expect(scan.targets.has(b)).toBe(true);
  });

  test("a dist published after the scan is read; unchanged ones are not", () => {
    const f = fixture();
    const scan = scanServedDists(f.worktrees);
    const c = f.entry("c", 0);
    const other = joinAppPath(f.worktrees, "ns2", "web.live.2");
    mkdirSync(joinAppPath(other, "artifacts"), { recursive: true });
    symlinkSync(c, joinAppPath(other, "artifacts", "c"));
    expect(refreshServedDists(scan, f.worktrees).reread).toBe(1);
    expect(scan.targets.has(c)).toBe(true);
    expect(refreshServedDists(scan, f.worktrees).reread).toBe(0);
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
      referenced: servedDistTargets(f.worktrees),
      survey,
    });
    expect(existsSync(linked)).toBe(true);
  });
});
