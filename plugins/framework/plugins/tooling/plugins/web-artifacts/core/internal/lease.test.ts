import { describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flockRelease, flockTry } from "@plugins/packages/plugins/flock/core";
import {
  liveLeaseTargets,
  openBuildLease,
  pruneWebArtifactCaches,
  type LeaseLayout,
} from "./lease";
import { removeCacheEntry, type CachePrunePolicy } from "./store";

const DAY = 24 * 60 * 60 * 1000;

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "web-artifacts-lease-"));
  const store = join(base, "store");
  const worktrees = join(base, "worktrees"); // no dists: only leases are roots
  mkdirSync(store, { recursive: true });
  const layout: LeaseLayout = {
    lockFile: join(base, "store.lock"),
    leasesDir: join(base, "leases"),
  };
  // Every entry is older than the prune's young-entry margin (1 min), so only
  // roots keep it: what a lease protects is never the margin's doing.
  const entry = (name: string, ageMs: number): string => {
    const p = join(store, name);
    mkdirSync(p);
    writeFileSync(join(p, "meta.json"), "{}");
    const t = new Date(Date.now() - ageMs - 2 * 60 * 1000);
    utimesSync(p, t, t);
    return p;
  };
  // A cap of 0 unreferenced entries: every prune removes every unpinned entry,
  // the worst case the fleet was in (roots alone past the old total cap).
  const policy: CachePrunePolicy = {
    root: store,
    maxAgeMs: 14 * DAY,
    maxUnreferenced: 0,
    trimTo: 0,
  };
  const prune = () =>
    pruneWebArtifactCaches({ layout, worktrees, policies: [policy] });
  return { base, store, layout, entry, prune };
}

describe("build lease", () => {
  test("a pinned entry survives a prune that removes every unpinned one", async () => {
    const f = fixture();
    const reused = f.entry("reused", 5 * DAY);
    const other = f.entry("other", 0);
    const lease = openBuildLease(f.layout);
    await lease.pin([reused]);
    await f.prune();
    expect(existsSync(reused)).toBe(true);
    expect(existsSync(other)).toBe(false);
    await lease.release();
    await f.prune();
    expect(existsSync(reused)).toBe(false);
  });

  test("an entry pinned before it is published is protected once it lands", async () => {
    const f = fixture();
    const lease = openBuildLease(f.layout);
    const future = join(f.store, "future");
    await lease.pin([future]);
    f.entry("future", 0); // the publish, after the pin
    await f.prune();
    expect(existsSync(future)).toBe(true);
    await lease.release();
  });

  test("release removes the lease dir; pinning after release throws", async () => {
    const f = fixture();
    const lease = openBuildLease(f.layout);
    await lease.pin([f.entry("a", 0)]);
    expect(readdirSync(f.layout.leasesDir)).toHaveLength(1);
    await lease.release();
    expect(readdirSync(f.layout.leasesDir)).toHaveLength(0);
    const outcome = await lease.pin([join(f.store, "b")]).then(
      () => "pinned",
      (err: unknown) => String(err),
    );
    expect(outcome).toMatch(/pinned after release/);
  });

  test("a lease whose owner died (its lock is free) is reaped, its pins released", async () => {
    const f = fixture();
    const orphan = f.entry("orphan", 0);
    const dead = join(f.layout.leasesDir, "12345-deadbeef");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "owner.lock"), "");
    symlinkSync(orphan, join(dead, "0"));
    await f.prune();
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
  });

  test("a live lease's pins are roots; a lease without an owner lock is dead", () => {
    const f = fixture();
    const live = join(f.layout.leasesDir, "live");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "owner.lock"), "");
    symlinkSync("/x/kept", join(live, "0"));
    const fd = openSync(join(live, "owner.lock"), "r");
    expect(flockTry(fd)).toBe(true); // the owner, alive
    const noLock = join(f.layout.leasesDir, "nolock");
    mkdirSync(noLock);
    symlinkSync("/x/gone", join(noLock, "0"));
    try {
      expect([...liveLeaseTargets(f.layout.leasesDir)]).toEqual(["/x/kept"]);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(noLock)).toBe(false);
    } finally {
      flockRelease(fd);
      closeSync(fd);
    }
  });

  test("a pin waits for a running prune (exclusive store lock), then lands", async () => {
    const f = fixture();
    const target = f.entry("t", 0);
    mkdirSync(f.base, { recursive: true });
    const fd = openSync(f.layout.lockFile, "a");
    expect(flockTry(fd)).toBe(true); // a prune in progress
    const lease = openBuildLease(f.layout);
    let landed = false;
    const pinning = lease.pin([target]).then(() => {
      landed = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(landed).toBe(false);
    flockRelease(fd);
    closeSync(fd);
    await pinning;
    expect(landed).toBe(true);
    await f.prune();
    expect(existsSync(target)).toBe(true);
    await lease.release();
  });
});

describe("build lease under a contended store lock", () => {
  const holdExclusive = (lockFile: string) => {
    const fd = openSync(lockFile, "a");
    expect(flockTry(fd)).toBe(true); // a prune in progress
    return () => {
      flockRelease(fd);
      closeSync(fd);
    };
  };

  test("concurrent pins fold into one batch: every one lands once the prune ends", async () => {
    const f = fixture();
    const targets = Array.from({ length: 200 }, (_, i) => f.entry(`t${i}`, 0));
    const release = holdExclusive(f.layout.lockFile);
    const lease = openBuildLease(f.layout);
    let landed = 0;
    const pins = targets.map((t) =>
      lease.pin([t]).then(() => {
        landed++;
      }),
    );
    await new Promise((r) => setImmediate(r));
    expect(landed).toBe(0);
    release();
    await Promise.all(pins);
    expect(landed).toBe(targets.length);
    const leaseDirs = readdirSync(f.layout.leasesDir);
    expect(leaseDirs).toHaveLength(1);
    // One link per path, however the calls were batched.
    expect(readdirSync(join(f.layout.leasesDir, ...leaseDirs))).toHaveLength(
      targets.length + 1,
    );
    await f.prune();
    for (const t of targets) expect(existsSync(t)).toBe(true);
    await lease.release();
  });

  test("a release waits for a running prune, so the prune never sees it half-removed", async () => {
    const f = fixture();
    const lease = openBuildLease(f.layout);
    await lease.pin([f.entry("a", 0)]);
    const release = holdExclusive(f.layout.lockFile);
    let released = false;
    const releasing = lease.release().then(() => {
      released = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(released).toBe(false);
    expect(readdirSync(f.layout.leasesDir)).toHaveLength(1);
    release();
    await releasing;
    expect(readdirSync(f.layout.leasesDir)).toHaveLength(0);
  });

  test("a release waits for a pin in flight before removing the lease", async () => {
    const f = fixture();
    const lease = openBuildLease(f.layout);
    const release = holdExclusive(f.layout.lockFile);
    const pinning = lease.pin([f.entry("a", 0)]);
    const releasing = lease.release();
    release();
    await pinning;
    await releasing;
    expect(readdirSync(f.layout.leasesDir)).toHaveLength(0);
  });
});

describe("removeCacheEntry", () => {
  const raced = (code: string): Error =>
    Object.assign(new Error(`${code}: raced`), { code });

  test("EPERM / ENOENT from a concurrent remover that finished is tolerated", () => {
    const f = fixture();
    for (const code of ["EPERM", "ENOENT"]) {
      const gone = join(f.store, `gone-${code}`);
      expect(() =>
        removeCacheEntry(gone, () => {
          throw raced(code);
        }),
      ).not.toThrow();
    }
  });

  test("a race that leaves the entry in place is retried once", () => {
    const f = fixture();
    const p = f.entry("mid-way", 0);
    let calls = 0;
    removeCacheEntry(p, (path) => {
      calls++;
      if (calls === 1) throw raced("EPERM");
      removeCacheEntry(path); // the retry does the real removal
    });
    expect(calls).toBe(2);
    expect(existsSync(p)).toBe(false);
  });

  test("a race code whose entry stays after the retry throws", () => {
    const f = fixture();
    const p = f.entry("stuck", 0);
    expect(() =>
      removeCacheEntry(p, () => {
        throw raced("EPERM");
      }),
    ).toThrow(/EPERM/);
  });

  test("any other error throws, even if the entry is gone", () => {
    const f = fixture();
    expect(() =>
      removeCacheEntry(join(f.store, "nope"), () => {
        throw raced("EACCES");
      }),
    ).toThrow(/EACCES/);
  });
});
