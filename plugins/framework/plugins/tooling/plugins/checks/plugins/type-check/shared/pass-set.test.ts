// The generation store: what an open costs, how long an entry lives, and
// what a hit in an older generation does — on a fake clock over a temp dir.

import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  minLifetimeMs,
  openPassSet,
  passSetOpenStats,
  type PassSetBounds,
  type PassSetDir,
} from "./pass-set";

const DAY = 24 * 60 * 60 * 1000;
// 4 generations of one day each.
const BOUNDS: PassSetBounds = {
  maxAgeMs: 4 * DAY,
  generations: 4,
  maxEntries: 1000,
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): PassSetDir {
  const path = mkdtempSync(join(tmpdir(), "pass-set-"));
  dirs.push(path);
  return {
    path,
    file: (...segments: string[]) => join(path, ...segments),
    ensure: () => {
      mkdirSync(path, { recursive: true });
      return path;
    },
  };
}

/** A clock the test moves; starts mid-way through a generation's period. */
function clock(start = 1000 * DAY + DAY / 2) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const gens = (dir: PassSetDir): string[] =>
  readdirSync(join(dir.path, "generations"))
    .filter((n) => /^g\d+$/.test(n))
    .sort();

test("minLifetimeMs is (generations − 1) periods", () => {
  expect(minLifetimeMs(BOUNDS)).toBe(3 * DAY);
  expect(minLifetimeMs({ ...BOUNDS, maxAgeMs: 14 * DAY })).toBe(10.5 * DAY);
});

test("fewer than two generations is refused", () => {
  expect(() => openPassSet(tempDir(), { ...BOUNDS, generations: 1 })).toThrow(
    /generations must be an integer ≥ 2/,
  );
});

test("record, read, has, touch round-trip in the current generation", () => {
  const dir = tempDir();
  const c = clock();
  const set = openPassSet(dir, BOUNDS, c);
  expect(set.has("k")).toBe(false);
  expect(set.read("k")).toBeUndefined();
  expect(set.touch("k")).toBe(false);
  set.record("k", { v: 1 });
  expect(set.has("k")).toBe(true);
  expect(set.touch("k")).toBe(true);
  expect(set.read("k")).toMatchObject({ v: 1, recordedAt: c.now() });
  expect(gens(dir)).toHaveLength(1);
});

test("an unused entry is kept more than minLifetimeMs and at most maxAgeMs", () => {
  for (const offset of [0, 0.5 * DAY, DAY - 1]) {
    const dir = tempDir();
    // Recorded `offset` into its generation's period.
    const c = clock(1000 * DAY + offset);
    openPassSet(dir, BOUNDS, c).record("k", { v: 1 });
    const t0 = c.now();
    const alive = (at: number): boolean => {
      c.advance(t0 + at - c.now());
      return openPassSet(dir, BOUNDS, c).read("k") !== undefined;
    };
    // `read` would promote, so probe each instant on a fresh copy of the
    // timeline: only the first read that misses tells the lifetime.
    expect(alive(minLifetimeMs(BOUNDS) - 1)).toBe(true);
  }
  for (const offset of [0, 0.5 * DAY, DAY - 1]) {
    const dir = tempDir();
    const c = clock(1000 * DAY + offset);
    openPassSet(dir, BOUNDS, c).record("k", { v: 1 });
    c.advance(BOUNDS.maxAgeMs);
    const set = openPassSet(dir, BOUNDS, c);
    expect(set.has("k")).toBe(false);
  }
});

test("a hit in an older generation is promoted, and outlives its old generation", () => {
  const dir = tempDir();
  const c = clock();
  openPassSet(dir, BOUNDS, c).record("k", { v: 1 });
  c.advance(2 * DAY);
  const set = openPassSet(dir, BOUNDS, c);
  expect(set.read("k")).toMatchObject({ v: 1 });
  expect(gens(dir)).toHaveLength(2); // the old one, and the promotion's
  // Past the original generation's drop, still there: it was used.
  c.advance(3 * DAY);
  const later = openPassSet(dir, BOUNDS, c);
  expect(later.read("k")).toMatchObject({ v: 1 });
  // The original generation is gone.
  expect(gens(dir)).not.toContain(`g${Math.floor((c.now() - 5 * DAY) / DAY)}`);
});

test("touch and has promote; an entry checked by has survives a drop", () => {
  const dir = tempDir();
  const c = clock();
  openPassSet(dir, BOUNDS, c).record("a", { v: 1 });
  openPassSet(dir, BOUNDS, c).record("b", { v: 2 });
  c.advance(3 * DAY);
  const set = openPassSet(dir, BOUNDS, c);
  expect(set.has("a")).toBe(true);
  expect(set.touch("b")).toBe(true);
  c.advance(2 * DAY); // the recording generation is now out of the window
  const later = openPassSet(dir, BOUNDS, c);
  expect(later.read("a")).toMatchObject({ v: 1 });
  expect(later.read("b")).toMatchObject({ v: 2 });
});

test("a newer record wins over an older generation's copy", () => {
  const dir = tempDir();
  const c = clock();
  openPassSet(dir, BOUNDS, c).record("k", { v: 1 });
  c.advance(DAY);
  const set = openPassSet(dir, BOUNDS, c);
  set.record("k", { v: 2 });
  expect(set.read("k")).toMatchObject({ v: 2 });
});

test("an open drops expired generations whole and lists only generations/", () => {
  const dir = tempDir();
  const c = clock();
  const set = openPassSet(dir, BOUNDS, c);
  for (let i = 0; i < 50; i++) set.record(`k${i}`, { i });
  const before = passSetOpenStats().dropped;
  c.advance(4 * DAY);
  openPassSet(dir, BOUNDS, c);
  expect(passSetOpenStats().dropped).toBe(before + 1);
  expect(gens(dir)).toEqual([]);
  expect(
    readdirSync(join(dir.path, "generations")).filter((n) =>
      n.startsWith(".trash-"),
    ),
  ).toEqual([]);
});

test("two openers racing a drop: both succeed, the generation goes once", () => {
  const dir = tempDir();
  const c = clock();
  const old = openPassSet(dir, BOUNDS, c);
  old.record("k", { v: 1 });
  c.advance(4 * DAY);
  const before = passSetOpenStats().dropped;
  const a = openPassSet(dir, BOUNDS, c);
  const b = openPassSet(dir, BOUNDS, c);
  expect(passSetOpenStats().dropped).toBe(before + 1);
  expect(a.has("k")).toBe(false);
  expect(b.has("k")).toBe(false);
  // A set opened before the drop, still on its old window, reads a miss
  // rather than failing — and writes into the generation the clock names.
  expect(old.read("k")).toBeUndefined();
  old.record("k", { v: 2 });
  expect(b.read("k")).toMatchObject({ v: 2 });
});

test("a leftover trash directory is removed by the next open", () => {
  const dir = tempDir();
  const c = clock();
  openPassSet(dir, BOUNDS, c);
  const trash = join(dir.path, "generations", ".trash-g1-1-abc");
  mkdirSync(trash);
  writeFileSync(join(trash, "x.json"), "{}");
  openPassSet(dir, BOUNDS, c);
  expect(existsSync(trash)).toBe(false);
});

test("the count backstop drops the oldest generation early, never the current", () => {
  const dir = tempDir();
  const c = clock();
  const bounds = { ...BOUNDS, maxEntries: 10 };
  let set = openPassSet(dir, bounds, c);
  for (let i = 0; i < 8; i++) set.record(`old${i}`, { i });
  c.advance(DAY);
  set = openPassSet(dir, bounds, c);
  for (let i = 0; i < 8; i++) set.record(`new${i}`, { i });
  // 16 > 10: the next open drops the older generation, keeps the current.
  set = openPassSet(dir, bounds, c);
  expect(set.has("old0")).toBe(false);
  expect(set.has("new0")).toBe(true);
  // The current generation alone over the bound stays: it is never dropped.
  for (let i = 8; i < 20; i++) set.record(`new${i}`, { i });
  set = openPassSet(dir, bounds, c);
  expect(set.has("new19")).toBe(true);
});

test("promotions count toward the backstop as directory entries", () => {
  const dir = tempDir();
  const c = clock();
  openPassSet(dir, BOUNDS, c).record("k", { v: 1 });
  c.advance(DAY);
  openPassSet(dir, BOUNDS, c).read("k");
  const cur = Math.floor(c.now() / DAY);
  expect(
    readFileSync(join(dir.path, "generations", `g${cur}`, ".writes"), "utf8"),
  ).toBe("1");
});

test("a store with no legacy entries is marked swept on creation", () => {
  const dir = tempDir();
  openPassSet(dir, BOUNDS, clock());
  expect(existsSync(join(dir.path, "generations", ".legacy-swept"))).toBe(true);
});

test("legacy flat entries are read, promoted, and swept once after maxAgeMs", () => {
  const dir = tempDir();
  const c = clock();
  // The flat layout before the switch: one `<sha256(key)>.json` per entry.
  const legacy = (key: string) =>
    join(
      dir.path,
      `${new Bun.CryptoHasher("sha256").update(key).digest("hex")}.json`,
    );
  writeFileSync(legacy("used"), JSON.stringify({ v: "used" }));
  writeFileSync(legacy("unused"), JSON.stringify({ v: "unused" }));
  writeFileSync(join(dir.path, ".last-prune"), "");
  const set = openPassSet(dir, BOUNDS, c);
  expect(existsSync(join(dir.path, "generations", ".legacy-swept"))).toBe(
    false,
  );
  expect(set.read("used")).toMatchObject({ v: "used" });
  expect(set.has("unused")).toBe(true); // presence is use: promoted too
  // Promoted copies are hard links into the current generation.
  expect(gens(dir)).toHaveLength(1);
  writeFileSync(legacy("never-read"), JSON.stringify({ v: 3 }));
  c.advance(BOUNDS.maxAgeMs - 1);
  // Not yet: within maxAgeMs of the generations' birth.
  expect(openPassSet(dir, BOUNDS, c).has("never-read")).toBe(true);
  c.advance(2);
  const later = openPassSet(dir, BOUNDS, c);
  expect(existsSync(legacy("used"))).toBe(false);
  expect(existsSync(legacy("never-read"))).toBe(false);
  expect(existsSync(join(dir.path, ".last-prune"))).toBe(false);
  expect(existsSync(join(dir.path, "generations", ".legacy-swept"))).toBe(true);
  // `never-read` was promoted by the `has` above, so it survived its legacy file.
  expect(later.read("never-read")).toMatchObject({ v: 3 });
});

test("the store's dir removed under an open set: the next record recreates it", () => {
  const dir = tempDir();
  const c = clock();
  const set = openPassSet(dir, BOUNDS, c);
  set.record("a", { v: 1 });
  rmSync(dir.path, { recursive: true, force: true });
  expect(set.read("a")).toBeUndefined();
  set.record("b", { v: 2 });
  expect(set.read("b")).toMatchObject({ v: 2 });
});

test("removal is bounded per open: a dropped generation is unseen at once, unlinked across opens", () => {
  const dir = tempDir();
  const c = clock();
  const set = openPassSet(dir, BOUNDS, c);
  for (let i = 0; i < 10; i++) set.record(`k${i}`, { i });
  c.advance(4 * DAY);
  const trashOf = () =>
    readdirSync(join(dir.path, "generations")).filter((n) =>
      n.startsWith(".trash-"),
    );
  const first = openPassSet(dir, BOUNDS, { ...c, removeBudget: 4 });
  expect(first.has("k0")).toBe(false);
  expect(trashOf()).toHaveLength(1);
  // 10 entries + the write counter: three opens of 4.
  openPassSet(dir, BOUNDS, { ...c, removeBudget: 4 });
  expect(trashOf()).toHaveLength(1);
  openPassSet(dir, BOUNDS, { ...c, removeBudget: 4 });
  expect(trashOf()).toEqual([]);
});

test("expired legacy entries are never read, even before the sweep finishes", () => {
  const dir = tempDir();
  const c = clock();
  const legacy = (key: string) =>
    join(
      dir.path,
      `${new Bun.CryptoHasher("sha256").update(key).digest("hex")}.json`,
    );
  for (let i = 0; i < 5; i++) {
    writeFileSync(legacy(`k${i}`), JSON.stringify({ i }));
  }
  openPassSet(dir, BOUNDS, c);
  c.advance(BOUNDS.maxAgeMs + 1);
  const set = openPassSet(dir, BOUNDS, { ...c, removeBudget: 2 });
  // Not all unlinked yet, and none readable.
  expect(
    readdirSync(dir.path).filter((n) => n.endsWith(".json")).length,
  ).toBeGreaterThan(0);
  for (let i = 0; i < 5; i++) expect(set.has(`k${i}`)).toBe(false);
  expect(existsSync(join(dir.path, "generations", ".legacy-swept"))).toBe(
    false,
  );
  for (let i = 0; i < 3; i++) {
    openPassSet(dir, BOUNDS, { ...c, removeBudget: 2 });
  }
  expect(readdirSync(dir.path).filter((n) => n.endsWith(".json"))).toEqual([]);
  expect(existsSync(join(dir.path, "generations", ".legacy-swept"))).toBe(true);
});
