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
import { pruneCacheDir } from "./store";
import { servedDistTargets } from "./served-dists";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "served-dists-"));
  const store = join(base, "store");
  const worktrees = join(base, "worktrees");
  mkdirSync(store, { recursive: true });
  // A served dist: ns/web -> ns/web.live.1, linking store entries.
  const live = join(worktrees, "ns", "web.live.1");
  mkdirSync(join(live, "artifacts"), { recursive: true });
  symlinkSync("web.live.1", join(worktrees, "ns", "web"));
  const entry = (name: string, ageMs: number): string => {
    const p = join(store, name);
    mkdirSync(p);
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
    return p;
  };
  const link = (name: string, target: string): void =>
    symlinkSync(target, join(live, "artifacts", name));
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
    expect(servedDistTargets(join(tmpdir(), "no-such-dir-xyz")).size).toBe(0);
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
      maxEntries: 100,
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
      maxEntries: 4,
      trimTo: 3,
      referenced: servedDistTargets(f.worktrees),
    });
    expect(existsSync(oldest)).toBe(true);
    // 6 total, trim to 3: the referenced one + the 2 newest unreferenced remain.
    expect(others.map((p) => existsSync(p))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  test("an entry younger than the referenced snapshot is never trimmed", () => {
    const f = fixture();
    const old = [0, 1].map((i) => f.entry(`old${i}`, (3 + i) * MINUTE));
    // Published (and pinned) while the prune walked: its snapshot predates them.
    const fresh = [0, 1].map((i) => f.entry(`fresh${i}`, i * 1000));
    pruneCacheDir({
      root: f.store,
      maxAgeMs: 14 * DAY,
      maxEntries: 2,
      trimTo: 1,
      referenced: servedDistTargets(f.worktrees),
    });
    expect(fresh.every((p) => existsSync(p))).toBe(true);
    expect(old.some((p) => existsSync(p))).toBe(false);
  });

  test("referenced entries beyond the cap are all kept", () => {
    const f = fixture();
    const refs = [0, 1, 2, 3].map((i) => {
      const p = f.entry(`r${i}`, (i + 1) * 1000);
      f.link(`r${i}`, p);
      return p;
    });
    const spare = f.entry("spare", 2 * MINUTE);
    pruneCacheDir({
      root: f.store,
      maxAgeMs: 14 * DAY,
      maxEntries: 2,
      trimTo: 1,
      referenced: servedDistTargets(f.worktrees),
    });
    expect(refs.every((p) => existsSync(p))).toBe(true);
    expect(existsSync(spare)).toBe(false);
  });
});
