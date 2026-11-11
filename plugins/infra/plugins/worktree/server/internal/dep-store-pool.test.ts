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

function poolNames(): string[] {
  const pool = depStorePoolDir(repo);
  return existsSync(pool) ? readdirSync(pool).sort() : [];
}

describe("harvestDepStore", () => {
  test("moves an untouched store into the pool", async () => {
    const checkout = installedCheckout("att-1");
    const r = await harvestDepStore(repo, checkout, 1000);
    expect(r).toEqual({ kind: "harvested", entry: "1000-att-1" });
    expect(existsSync(join(checkout, "node_modules", ".bun"))).toBe(false);
    expect(poolNames()).toEqual(["1000-att-1"]);
  });

  test("skips a checkout whose install never finished", async () => {
    const checkout = installedCheckout("att-1");
    rmSync(join(checkout, "node_modules", ".equin-deps"));
    expect(await harvestDepStore(repo, checkout, 1000)).toEqual({
      kind: "skipped",
      why: "no install stamp",
    });
    expect(poolNames()).toEqual([]);
  });

  test("skips a checkout that has no store", async () => {
    expect(await harvestDepStore(repo, emptyCheckout("att-1"), 1000)).toEqual({
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
    expect(await harvestDepStore(repo, checkout, 1000)).toEqual({
      kind: "skipped",
      why: "changed after its install: left-pad@1.0.0/index.js",
    });
    expect(existsSync(file)).toBe(true);
  });

  test("keeps every store it harvests: a burst of reaps deletes none", async () => {
    const names = ["att-1", "att-2", "att-3", "att-4", "att-5"];
    await Promise.all(
      names.map((name, i) =>
        harvestDepStore(repo, installedCheckout(name), 1000 + i),
      ),
    );
    expect(poolNames()).toEqual(names.map((n, i) => `${1000 + i}-${n}`));
  });

  test("a failure is a result, never a throw: the removal it follows is committed", async () => {
    const pool = depStorePoolDir(repo);
    mkdirSync(pool, { recursive: true });
    chmodSync(pool, 0o555);
    const r = await harvestDepStore(repo, installedCheckout("att-1"), 1000);
    expect(r.kind).toBe("failed");
  });
});

describe("adoptDepStore", () => {
  test("hands the newest store to a checkout with no node_modules", async () => {
    await harvestDepStore(repo, installedCheckout("att-1", "a@1.0.0"), 1000);
    await harvestDepStore(repo, installedCheckout("att-2", "b@1.0.0"), 2000);
    const fresh = emptyCheckout("fresh");
    expect(await adoptDepStore(repo, fresh, 2500)).toEqual({
      kind: "adopted",
      entry: "2000-att-2",
      ageMs: 500,
    });
    expect(
      readFileSync(
        join(fresh, "node_modules", ".bun", "b@1.0.0", "index.js"),
        "utf8",
      ),
    ).toBe("// b@1.0.0\n");
    // No stamp comes with it: the install still runs and re-links the store.
    expect(existsSync(join(fresh, "node_modules", ".equin-deps"))).toBe(false);
    expect(poolNames()).toEqual(["1000-att-1"]);
  });

  test("leaves a checkout that already has node_modules alone", async () => {
    await harvestDepStore(repo, installedCheckout("att-1"), 1000);
    const claimed = emptyCheckout("claimed");
    mkdirSync(join(claimed, "node_modules"));
    expect(await adoptDepStore(repo, claimed, 2000)).toEqual({
      kind: "present",
    });
    expect(poolNames()).toEqual(["1000-att-1"]);
  });

  test("the last store stays as the seed: the checkout gets a file-by-file copy", async () => {
    await harvestDepStore(repo, installedCheckout("att-1", "a@1.0.0"), 1000);
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
    expect(poolNames()).toEqual(["1000-att-1"]);
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
    await harvestDepStore(repo, checkout, 1000);
    const fresh = emptyCheckout("fresh");
    await adoptDepStore(repo, fresh, 2000);
    expect(readlinkSync(join(fresh, "node_modules", ".bun", "link-to-a"))).toBe(
      "../a@1.0.0",
    );
  });

  test("two adopters of the last store: neither takes it, and each gets a copy or installs cold", async () => {
    await harvestDepStore(repo, installedCheckout("att-1"), 1000);
    const a = emptyCheckout("a");
    const b = emptyCheckout("b");
    const results = await Promise.all([
      adoptDepStore(repo, a, 2000),
      adoptDepStore(repo, b, 2000),
    ]);
    expect(results.some((r) => r.kind === "cloned")).toBe(true);
    for (const [r, c] of [
      [results[0]!, a],
      [results[1]!, b],
    ] as const) {
      expect(r.kind === "cloned" || r.kind === "none").toBe(true);
      expect(existsSync(join(c, "node_modules"))).toBe(r.kind === "cloned");
    }
    expect(poolNames()).toEqual(["1000-att-1"]);
  });

  test("never takes an entry a delete has claimed", async () => {
    await harvestDepStore(repo, installedCheckout("att-1"), 1000);
    // A delete's claim: the entry is renamed before its rm starts.
    const pool = depStorePoolDir(repo);
    renameSync(
      join(pool, "1000-att-1"),
      join(pool, ".claimed-1500-1000-att-1-x"),
    );
    expect(await adoptDepStore(repo, emptyCheckout("fresh"), 2000)).toEqual({
      kind: "none",
    });
  });

  test("a move that fails after the claim puts the store back", async () => {
    await harvestDepStore(repo, installedCheckout("att-1"), 1000);
    const gone = join(base, "gone"); // never created: mkdir of its node_modules fails
    expect(adoptDepStore(repo, gone, 2000)).rejects.toThrow("ENOENT");
    await Bun.sleep(50);
    expect(poolNames()).toEqual(["1000-att-1"]);
  });

  test("passes over a store past its age bound", async () => {
    await harvestDepStore(repo, installedCheckout("att-1"), 1000);
    expect(
      await adoptDepStore(repo, emptyCheckout("fresh"), 1000 + 8 * DAY),
    ).toEqual({ kind: "none" });
  });
});

describe("emptyDepStorePool", () => {
  test("deletes expired stores and dead processes' transient names", async () => {
    await harvestDepStore(repo, installedCheckout("att-1"), 1000);
    const pool = depStorePoolDir(repo);
    const now = 8 * DAY + 60_000;
    // Dead: a crashed harvest's staging dir, a killed delete's claim.
    mkdirSync(join(pool, ".staging-1000-att-9"));
    mkdirSync(join(pool, ".claimed-1000-att-7-x"));
    // Live: both inside the grace.
    mkdirSync(join(pool, `.staging-${8 * DAY}-att-8`));
    mkdirSync(join(pool, `.claimed-${8 * DAY}-att-6-y`));
    expect(await emptyDepStorePool(repo, now)).toBe(3);
    expect(poolNames()).toEqual([
      `.claimed-${8 * DAY}-att-6-y`,
      `.staging-${8 * DAY}-att-8`,
    ]);
  });

  test("a live claim of an old entry is not mistaken for a dead one", async () => {
    await harvestDepStore(repo, installedCheckout("att-1"), 1000);
    const pool = depStorePoolDir(repo);
    // Claimed just now (an adopter between its claim and its move), of an
    // entry harvested days earlier.
    const now = 3 * DAY;
    const claimed = `.claimed-${now - 1000}-1000-att-1-x`;
    renameSync(join(pool, "1000-att-1"), join(pool, claimed));
    expect(await emptyDepStorePool(repo, now)).toBe(0);
    expect(poolNames()).toEqual([claimed]);
  });

  test("an absent pool is empty", async () => {
    expect(await emptyDepStorePool(repo, 1000)).toBe(0);
  });
});
