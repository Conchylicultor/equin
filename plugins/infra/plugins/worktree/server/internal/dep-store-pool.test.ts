import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  adoptDepStore,
  depStorePoolDir,
  emptyDepStorePool,
  harvestDepStore,
} from "./dep-store-pool";
import { holdSeed, holdTransient, type RenamePool } from "./rename-pool";

const DAY = 24 * 60 * 60_000;
let base: AppPath;
let repo: AppPath;

beforeEach(() => {
  base = asAppPath(realpathSync(mkdtempSync(join(tmpdir(), "dep-pool-"))));
  repo = joinAppPath(base, "repo");
  mkdirSync(repo);
});

afterEach(() => {
  const pool = depStorePoolDir(repo);
  if (existsSync(pool)) chmodSync(pool, 0o755);
  rmSync(base, { recursive: true, force: true });
});

/** A removed checkout with an installed store: one package file, then the stamp. */
function installedCheckout(name: string, pkg = "left-pad@1.0.0"): string {
  const checkout = join(base, name);
  const store = join(checkout, "node_modules", ".bun");
  const file = join(store, pkg, "index.js");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `// ${pkg}\n`);
  // Store entries predate the stamp, as a real install's do.
  const past = new Date(Date.now() - 60_000);
  for (const p of [file, join(file, ".."), store]) utimesSync(p, past, past);
  writeFileSync(join(checkout, "node_modules", ".equin-deps"), "{}\n");
  return checkout;
}

function emptyCheckout(name: string): string {
  const checkout = join(base, name);
  mkdirSync(checkout);
  return checkout;
}

/** The pool's names, minus the seed's readers' lock (a stable file, made by the first reader). */
function poolNames(): string[] {
  const pool = depStorePoolDir(repo);
  return existsSync(pool)
    ? readdirSync(pool)
        .filter((n) => n !== "seed.lock")
        .sort()
    : [];
}

/** The seed's published name, from its `entry` file. */
function seedEntry(): string {
  return readFileSync(join(depStorePoolDir(repo), "seed", "entry"), "utf8");
}

function harvestAt(checkout: string, ms: number) {
  return harvestDepStore(repo, checkout, () => ms);
}

/** The pool as rename-pool sees it, for the tests that drive its holds directly. */
function renamePool(): RenamePool {
  return {
    what: "dependency store",
    dir: depStorePoolDir(repo),
    maxAgeMs: 7 * DAY,
    seeded: true,
  };
}

describe("harvestDepStore", () => {
  test("the first store harvested becomes the pool's seed", async () => {
    const checkout = installedCheckout("att-1");
    const r = await harvestAt(checkout, 1000);
    expect(r).toEqual({ kind: "harvested", entry: "1000-att-1", seed: true });
    expect(existsSync(join(checkout, "node_modules", ".bun"))).toBe(false);
    expect(poolNames()).toEqual(["seed"]);
    expect(seedEntry()).toBe("1000-att-1");
  });

  test("with a seed in place, a store is published as an entry", async () => {
    await harvestAt(installedCheckout("att-1"), 1000);
    expect(await harvestAt(installedCheckout("att-2"), 2000)).toEqual({
      kind: "harvested",
      entry: "2000-att-2",
      seed: false,
    });
    expect(poolNames()).toEqual(["2000-att-2", "seed"]);
  });

  test("an entry is named by the clock at its publish, not when its harvest began", async () => {
    // A harvest walks ~75k entries before it publishes: the first reading of
    // the clock is long gone by then.
    await harvestAt(installedCheckout("att-0"), 1000);
    const readings = [100, 5000];
    const r = await harvestDepStore(
      repo,
      installedCheckout("att-1"),
      () => readings.shift() ?? 5000,
    );
    expect(r).toEqual({ kind: "harvested", entry: "5000-att-1", seed: false });
  });

  test("skips a checkout whose install never finished", async () => {
    const checkout = installedCheckout("att-1");
    rmSync(join(checkout, "node_modules", ".equin-deps"));
    expect(await harvestAt(checkout, 1000)).toEqual({
      kind: "skipped",
      why: "no install stamp",
    });
    expect(poolNames()).toEqual([]);
  });

  test("skips a checkout that has no store", async () => {
    expect(await harvestAt(emptyCheckout("att-1"), 1000)).toEqual({
      kind: "skipped",
      why: "no dependency store",
    });
  });

  test("skips a store a package file was edited in after its install", async () => {
    const checkout = installedCheckout("att-1");
    const file = join(
      checkout,
      "node_modules",
      ".bun",
      "left-pad@1.0.0",
      "index.js",
    );
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    expect(await harvestAt(checkout, 1000)).toEqual({
      kind: "skipped",
      why: "changed after its install: left-pad@1.0.0/index.js",
    });
    expect(existsSync(file)).toBe(true);
  });

  test("keeps every store it harvests: a burst of reaps deletes none, and makes one seed", async () => {
    const names = ["att-1", "att-2", "att-3", "att-4", "att-5"];
    const results = await Promise.all(
      names.map((name, i) => harvestAt(installedCheckout(name), 1000 + i)),
    );
    const seeds = results.filter((r) => r.kind === "harvested" && r.seed);
    expect(seeds.length).toBe(1);
    const names_ = poolNames();
    expect(names_.length).toBe(5);
    expect(names_).toContain("seed");
  });

  test("a failure is a result, never a throw: the removal it follows is committed", async () => {
    const pool = depStorePoolDir(repo);
    mkdirSync(pool, { recursive: true });
    chmodSync(pool, 0o555);
    const r = await harvestAt(installedCheckout("att-1"), 1000);
    expect(r.kind).toBe("failed");
  });
});

describe("adoptDepStore", () => {
  test("hands the newest entry to a checkout with no node_modules", async () => {
    await harvestAt(installedCheckout("att-1", "a@1.0.0"), 1000); // the seed
    await harvestAt(installedCheckout("att-2", "b@1.0.0"), 2000);
    await harvestAt(installedCheckout("att-3", "c@1.0.0"), 3000);
    const fresh = emptyCheckout("fresh");
    expect(await adoptDepStore(repo, fresh, 3500)).toEqual({
      kind: "adopted",
      entry: "3000-att-3",
      ageMs: 500,
    });
    expect(
      readFileSync(
        join(fresh, "node_modules", ".bun", "c@1.0.0", "index.js"),
        "utf8",
      ),
    ).toBe("// c@1.0.0\n");
    // No stamp comes with it: the install still runs and re-links the store.
    expect(existsSync(join(fresh, "node_modules", ".equin-deps"))).toBe(false);
    expect(poolNames()).toEqual(["2000-att-2", "seed"]);
  });

  test("leaves a checkout that already has node_modules alone", async () => {
    await harvestAt(installedCheckout("att-1"), 1000);
    const claimed = emptyCheckout("claimed");
    mkdirSync(join(claimed, "node_modules"));
    expect(await adoptDepStore(repo, claimed, 2000)).toEqual({
      kind: "present",
    });
    expect(poolNames()).toEqual(["seed"]);
  });

  test("with no entry left, the checkout gets a file-by-file copy of the seed", async () => {
    await harvestAt(installedCheckout("att-1", "a@1.0.0"), 1000);
    const fresh = emptyCheckout("fresh");
    expect(await adoptDepStore(repo, fresh, 2000)).toEqual({
      kind: "cloned",
      entry: "1000-att-1",
      ageMs: 1000,
    });
    const file = join(fresh, "node_modules", ".bun", "a@1.0.0", "index.js");
    expect(readFileSync(file, "utf8")).toBe("// a@1.0.0\n");
    expect(existsSync(join(fresh, "node_modules", ".equin-deps"))).toBe(false);
    // The seed is untouched and still waits; no transient copy is left behind.
    expect(poolNames()).toEqual(["seed"]);
    // A copy, not a link: editing it leaves the seed as it was.
    writeFileSync(file, "// edited\n");
    const second = emptyCheckout("second");
    expect((await adoptDepStore(repo, second, 3000)).kind).toBe("cloned");
    expect(
      readFileSync(
        join(second, "node_modules", ".bun", "a@1.0.0", "index.js"),
        "utf8",
      ),
    ).toBe("// a@1.0.0\n");
  });

  test("copies symlinks as links", async () => {
    const checkout = installedCheckout("att-1", "a@1.0.0");
    symlinkSync(
      "../a@1.0.0",
      join(checkout, "node_modules", ".bun", "link-to-a"),
    );
    await harvestAt(checkout, 1000);
    const fresh = emptyCheckout("fresh");
    await adoptDepStore(repo, fresh, 2000);
    expect(readlinkSync(join(fresh, "node_modules", ".bun", "link-to-a"))).toBe(
      "../a@1.0.0",
    );
  });

  test("concurrent adopters of the seed: each gets a copy, none cold", async () => {
    await harvestAt(installedCheckout("att-1"), 1000);
    const checkouts = ["a", "b", "c", "d"].map(emptyCheckout);
    const results = await Promise.all(
      checkouts.map((c) => adoptDepStore(repo, c, 2000)),
    );
    for (const [i, r] of results.entries()) {
      expect(r.kind).toBe("cloned");
      expect(existsSync(join(checkouts[i]!, "node_modules", ".bun"))).toBe(
        true,
      );
    }
    expect(poolNames()).toEqual(["seed"]);
  });

  test("an adopter never renames the seed: a copy in flight keeps its source", async () => {
    // The seed's dir stays at its path for the whole adoption — the inode a
    // `cp` in another process is walking.
    await harvestAt(installedCheckout("att-1"), 1000);
    await harvestAt(installedCheckout("att-2"), 2000);
    const seedStore = join(depStorePoolDir(repo), "seed", "store");
    const watcher = watch(depStorePoolDir(repo));
    const renamed: string[] = [];
    watcher.on("change", (_kind, name) => {
      if (typeof name === "string" && name.includes("seed")) renamed.push(name);
    });
    // One takes the entry, the others copy the seed.
    await Promise.all(
      ["x", "y", "z"].map((c) => adoptDepStore(repo, emptyCheckout(c), 2500)),
    );
    await Bun.sleep(50);
    watcher.close();
    expect(renamed.filter((n) => n !== "seed.lock")).toEqual([]);
    expect(existsSync(seedStore)).toBe(true);
  });

  test("adopters whose clocks disagree at the age boundary agree on the seed", async () => {
    // Before: the seed was "the oldest entry within 7 days", per adopter. One
    // whose clock counted the oldest expired took the next one, which another
    // adopter, counting the oldest still live, was copying as its seed.
    await harvestAt(installedCheckout("att-1", "a@1.0.0"), 1000); // the seed
    await harvestAt(installedCheckout("att-2", "b@1.0.0"), 2000);
    const late = 1000 + 7 * DAY + 500; // the seed is past the bound by this clock
    const [x, y] = await Promise.all([
      adoptDepStore(repo, emptyCheckout("x"), late),
      adoptDepStore(repo, emptyCheckout("y"), 2500),
    ]);
    const byKind = Object.fromEntries([x, y].map((r) => [r.kind, r]));
    expect(Object.keys(byKind).sort()).toEqual(["adopted", "cloned"]);
    expect(byKind.adopted).toMatchObject({ entry: "2000-att-2" });
    expect(byKind.cloned).toMatchObject({ entry: "1000-att-1" });
    // And an adopter whose clock counts every entry expired still copies the
    // seed: only the sweep's one clock retires it.
    expect(
      await adoptDepStore(repo, emptyCheckout("z"), 2000 + 8 * DAY),
    ).toMatchObject({ kind: "cloned", entry: "1000-att-1" });
    expect(poolNames()).toEqual(["seed"]);
  });

  test("an entry published older than the seed is taken, never the seed", async () => {
    // A slow harvest that stamped its name early (the bug) or simply ran on a
    // lagging clock: its entry sorts older than the seed, and is still only
    // an entry.
    await harvestAt(installedCheckout("att-1", "a@1.0.0"), 1000); // the seed
    await harvestAt(installedCheckout("att-2", "b@1.0.0"), 500);
    expect(await adoptDepStore(repo, emptyCheckout("x"), 2000)).toMatchObject({
      kind: "adopted",
      entry: "500-att-2",
    });
    expect(await adoptDepStore(repo, emptyCheckout("y"), 2000)).toMatchObject({
      kind: "cloned",
      entry: "1000-att-1",
    });
  });

  test("never takes an entry a delete has claimed", async () => {
    await harvestAt(installedCheckout("att-1"), 1000); // the seed
    await harvestAt(installedCheckout("att-2"), 2000);
    // A delete's claim: the entry is renamed before its rm starts.
    const pool = depStorePoolDir(repo);
    renameSync(
      join(pool, "2000-att-2"),
      join(pool, ".claimed-2500-2000-att-2-x"),
    );
    expect(await adoptDepStore(repo, emptyCheckout("fresh"), 3000)).toEqual({
      kind: "cloned",
      entry: "1000-att-1",
      ageMs: 2000,
    });
  });

  test("a move that fails after the claim puts the store back", async () => {
    await harvestAt(installedCheckout("att-1"), 1000); // the seed
    await harvestAt(installedCheckout("att-2"), 2000);
    const gone = join(base, "gone"); // never created: mkdir of its node_modules fails
    expect(adoptDepStore(repo, gone, 2500)).rejects.toThrow("ENOENT");
    await Bun.sleep(50);
    expect(poolNames()).toEqual(["2000-att-2", "seed"]);
  });

  test("a copy that fails with the seed in place throws, and leaves nothing behind", async () => {
    const checkout = installedCheckout("att-1", "a@1.0.0");
    await harvestAt(checkout, 1000);
    const file = join(
      depStorePoolDir(repo),
      "seed",
      "store",
      "a@1.0.0",
      "index.js",
    );
    chmodSync(file, 0o000);
    const fresh = emptyCheckout("fresh");
    expect(adoptDepStore(repo, fresh, 2000)).rejects.toThrow(
      "copying the pool's seed",
    );
    await Bun.sleep(200);
    chmodSync(file, 0o644);
    expect(existsSync(join(fresh, "node_modules", ".bun"))).toBe(false);
    expect(poolNames()).toEqual(["seed"]);
  });

  test("passes over an entry past its age bound, to the seed", async () => {
    await harvestAt(installedCheckout("att-1"), 8 * DAY); // the seed
    await harvestAt(installedCheckout("att-2"), 1000);
    expect(
      await adoptDepStore(repo, emptyCheckout("fresh"), 9 * DAY),
    ).toMatchObject({ kind: "cloned", entry: `${8 * DAY}-att-1` });
    expect(poolNames()).toEqual(["1000-att-2", "seed"]);
  });

  test("an empty pool is a cold install", async () => {
    expect(await adoptDepStore(repo, emptyCheckout("fresh"), 1000)).toEqual({
      kind: "none",
    });
  });
});

describe("emptyDepStorePool", () => {
  test("deletes expired stores and dead processes' transient names", async () => {
    await harvestAt(installedCheckout("att-1"), 1000); // the seed
    await harvestAt(installedCheckout("att-2"), 2000);
    const pool = depStorePoolDir(repo);
    const now = 8 * DAY + 60_000;
    // Dead: a crashed harvest's staging dir, a killed delete's claim.
    mkdirSync(join(pool, ".staging-1000-att-9"));
    mkdirSync(join(pool, ".claimed-1000-att-7-x"));
    // Live: both inside the grace.
    mkdirSync(join(pool, `.staging-${8 * DAY}-att-8`));
    mkdirSync(join(pool, `.claimed-${8 * DAY}-att-6-y`));
    // The seed, the entry and the two dead names.
    expect(await emptyDepStorePool(repo, now)).toBe(4);
    expect(poolNames()).toEqual([
      `.claimed-${8 * DAY}-att-6-y`,
      `.staging-${8 * DAY}-att-8`,
    ]);
  });

  test("a retired seed is replaced by the newest entry within the bound", async () => {
    await harvestAt(installedCheckout("att-1"), 1000); // the seed
    await harvestAt(installedCheckout("att-2"), 2 * DAY);
    await harvestAt(installedCheckout("att-3"), 3 * DAY);
    expect(await emptyDepStorePool(repo, 8 * DAY)).toBe(1);
    expect(poolNames()).toEqual([`${2 * DAY}-att-2`, "seed"]);
    expect(seedEntry()).toBe(`${3 * DAY}-att-3`);
    // A pool from before the seed was a name (entries only) gets one too.
    rmSync(join(depStorePoolDir(repo), "seed"), { recursive: true });
    expect(await emptyDepStorePool(repo, 8 * DAY)).toBe(0);
    expect(poolNames()).toEqual(["seed"]);
    expect(seedEntry()).toBe(`${2 * DAY}-att-2`);
  });

  test("a seed past its bound is not retired while a copy of it is in flight", async () => {
    await harvestAt(installedCheckout("att-1"), 1000);
    const reader = await holdSeed(renamePool());
    expect(reader).not.toBeNull();
    expect(await emptyDepStorePool(repo, 8 * DAY)).toBe(0);
    expect(poolNames()).toEqual(["seed"]);
    reader!.release();
    expect(await emptyDepStorePool(repo, 8 * DAY)).toBe(1);
    expect(poolNames()).toEqual([]);
  });

  test("a copy still being written is never deleted, however long ago it began", async () => {
    // A machine asleep mid-`cp`: hours of wall time pass while the copy's
    // own timeout, counting awake time, has not.
    await harvestAt(installedCheckout("att-1"), 1000);
    const copy = await holdTransient(renamePool(), "clone-x", 1000);
    writeFileSync(join(copy.path, "partial"), "");
    expect(await emptyDepStorePool(repo, 1000 + DAY)).toBe(0);
    expect(existsSync(join(copy.path, "partial"))).toBe(true);
    copy.release(); // its writer died
    expect(await emptyDepStorePool(repo, 1000 + DAY)).toBe(1);
    expect(existsSync(copy.path)).toBe(false);
  });

  test("a seed with no entry time is retired, not a sweep that throws forever", async () => {
    await harvestAt(installedCheckout("att-1"), 1000); // the seed
    await harvestAt(installedCheckout("att-2"), 2000);
    rmSync(join(depStorePoolDir(repo), "seed", "entry"));
    expect(await emptyDepStorePool(repo, 3000)).toBe(1);
    expect(poolNames()).toEqual(["seed"]);
    expect(seedEntry()).toBe("2000-att-2");
  });

  test("a published entry carries no owner file", async () => {
    await harvestAt(installedCheckout("att-1"), 1000);
    await harvestAt(installedCheckout("att-2"), 2000);
    const pool = depStorePoolDir(repo);
    expect(readdirSync(join(pool, "seed")).sort()).toEqual(["entry", "store"]);
    expect(readdirSync(join(pool, "2000-att-2"))).toEqual(["store"]);
  });

  test("a live claim of an old entry is not mistaken for a dead one", async () => {
    await harvestAt(installedCheckout("att-1"), 1000); // the seed
    await harvestAt(installedCheckout("att-2"), 2000);
    const pool = depStorePoolDir(repo);
    // Claimed just now (an adopter between its claim and its move), of an
    // entry harvested days earlier.
    const now = 3 * DAY;
    const claimed = `.claimed-${now - 1000}-2000-att-2-x`;
    renameSync(join(pool, "2000-att-2"), join(pool, claimed));
    expect(await emptyDepStorePool(repo, now)).toBe(0);
    expect(poolNames()).toEqual([claimed, "seed"]);
  });

  test("an absent pool is empty", async () => {
    expect(await emptyDepStorePool(repo, 1000)).toBe(0);
  });
});
