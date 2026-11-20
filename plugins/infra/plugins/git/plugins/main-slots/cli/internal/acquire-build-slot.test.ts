import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  envEntries,
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  checkoutAdminDir,
  checkoutRef,
  SERVER_CORE_RELATIVE,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import {
  asNamespace,
  MAIN_WORKTREE_NAME,
} from "@plugins/infra/plugins/namespace/core";
import {
  holdSlotLeaseSync,
  renderDrainRecord,
  renderUnserved,
  SLOT_DRAIN_LOG_DIR,
  SLOT_HANDED_FILE,
  SLOT_LEASES_DIR,
  SLOT_UNSERVED_FILE,
} from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";
import {
  acquireSharedLease,
  claimHandedBuildSlot,
  holdSlotForLife,
  readSlotHolders,
  tryExclusiveLease,
} from "../../core/internal/lease";
import {
  clearSlotHanded,
  markSlotHanded,
  readSlotHanded,
} from "../../core/internal/handoff";
import { withSlotPool } from "../../core/internal/pool-lock";
import {
  currentLinkFor,
  currentLinksDir,
  listSlots,
  readUnserved,
  servedMainRoot,
  servedSlotOf,
  serveSlot,
  slotStates,
  stampUnserved,
} from "../../core/internal/slots";
import type { DrainSlowPayload } from "../../core/internal/reports";
import {
  acquireBuildSlot,
  runInBuildSlot,
  type HeldSlot,
} from "./acquire-build-slot";
import { reclaimSlots } from "./reclaim";

// Each case owns a data root (so its own slot pool) and real git repos.

const ORIGINAL_ROOT = readEnv("DIR");
const base = asAppPath(
  realpathSync(mkdtempSync(join(tmpdir(), "main-slots-"))),
);
afterAll(() => {
  if (ORIGINAL_ROOT === undefined) unsetEnv("DIR");
  else setEnv("DIR", ORIGINAL_ROOT);
  rmSync(base, { recursive: true, force: true });
});

let caseN = 0;
let dir: AppPath;
beforeEach(() => {
  dir = joinAppPath(base, `case-${++caseN}`);
  mkdirSync(dir, { recursive: true });
  setEnv("DIR", join(dir, "data"));
});

const noInstall = async (): Promise<void> => {};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnExpectOk(
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, timeoutMs: 60_000 },
  );
  return result.stdout.trim();
}

/** A repo with two commits; returns its root and both shas. */
async function repo(name: string): Promise<{
  root: AppPath;
  first: string;
  second: string;
}> {
  const root = joinAppPath(dir, name);
  mkdirSync(root, { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "one");
  const first = await git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "two\n");
  await git(root, "commit", "-q", "-am", "two");
  const second = await git(root, "rev-parse", "HEAD");
  return { root, first, second };
}

const MAIN = MAIN_WORKTREE_NAME;
const SONATA = asNamespace("sonata");
const WEBSITE = asNamespace("website");
const THRESHOLD_MS = 10_000;

/** A slot at `sha`, made (or reused) and let go: free unless something names it. */
async function slotAt(root: AppPath, sha: string): Promise<AppPath> {
  const got = await acquireBuildSlot(sha, {
    repoRoot: root,
    installDeps: noInstall,
  });
  await got.lease.release();
  return got.slot;
}

/** `n` distinct slots at `sha`, all let go (each made while the others were held). */
async function freshSlots(
  root: AppPath,
  sha: string,
  n: number,
): Promise<AppPath[]> {
  const got = [];
  for (let i = 0; i < n; i++)
    got.push(
      await acquireBuildSlot(sha, { repoRoot: root, installDeps: noInstall }),
    );
  for (const g of got) await g.lease.release();
  return got.map((g) => g.slot);
}

async function serve(slot: AppPath, ns = MAIN): Promise<void> {
  await serveSlot(slot, ns, { drainReportAfterMs: THRESHOLD_MS });
}

async function stateOf(slot: AppPath): Promise<string> {
  const s = (await slotStates()).find((x) => x.path === slot);
  if (s === undefined) throw new Error(`${slot} is not in the pool`);
  return s.state;
}

/** Collects the drain reports a reclaim files (and says they were written). */
function collector(): {
  filed: DrainSlowPayload[];
  file: (d: DrainSlowPayload) => Promise<boolean>;
} {
  const filed: DrainSlowPayload[] = [];
  return {
    filed,
    file: async (d) => {
      filed.push(d);
      return true;
    },
  };
}

describe("slotStates", () => {
  test("serving, building, draining and free, from links, specs and holder records", async () => {
    const { root, first } = await repo("repo");
    const [serving, draining, free, building] = await freshSlots(
      root,
      first,
      4,
    );
    await serve(serving!);
    const reader = await acquireSharedLease(draining!, "exec-child", "job.x");
    const build = await tryExclusiveLease(building!, "build", "build-1");
    if (build.kind !== "acquired") throw new Error("not acquired");

    expect(await stateOf(serving!)).toBe("serving");
    expect(await stateOf(draining!)).toBe("draining");
    expect(await stateOf(free!)).toBe("free");
    expect(await stateOf(building!)).toBe("building");
    const s = (await slotStates()).find((x) => x.path === serving)!;
    expect(s.servedBy).toEqual([MAIN]);

    // Shared after its handover, a build's slot is still being built.
    await build.lease.downgrade();
    expect(await stateOf(building!)).toBe("building");
    await build.lease.release();
    expect(await stateOf(building!)).toBe("free");
    await reader.release();
    expect(await stateOf(draining!)).toBe("free");
  });

  test("a slot a namespace's spec names serves, whatever the links say", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const spec = worktreeArtifacts.spec(SONATA);
    mkdirSync(dirname(spec), { recursive: true });
    writeFileSync(
      spec,
      JSON.stringify({ server: join(a, SERVER_CORE_RELATIVE) }),
    );
    expect(await stateOf(a)).toBe("serving");
    expect((await slotStates())[0]!.servedBy).toEqual([SONATA]);
  });

  test("a slot handed to a build by a live process is building", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    await markSlotHanded(a, "handoff-1");
    expect(await stateOf(a)).toBe("building");
  });

  test("a handoff mark whose hander lock is unheld is stale, even naming a live pid (pid reuse)", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    // A SIGKILLed hander whose pid now belongs to an unrelated live process:
    // its mark is left, its lock went with it.
    const mark = join((await checkoutAdminDir(a))!, SLOT_HANDED_FILE);
    writeFileSync(
      mark,
      JSON.stringify({ handoff: "handoff-1", pid: process.ppid, hold: "lock" }),
    );
    expect(await stateOf(a)).toBe("free");
    expect(existsSync(mark)).toBe(false);
    // Released, the mark and the lock go together.
    const hold = await markSlotHanded(a, "handoff-2");
    expect(await stateOf(a)).toBe("building");
    await hold.release();
    expect(existsSync(mark)).toBe(false);
    expect(await stateOf(a)).toBe("free");
  });

  test("a pre-lock mark (an older hander's `{handoff, pid}`) is judged by its pid", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const mark = join((await checkoutAdminDir(a))!, SLOT_HANDED_FILE);
    writeFileSync(
      mark,
      JSON.stringify({ handoff: "handoff-1", pid: process.pid }),
    );
    expect(await readSlotHanded(a)).toEqual({
      handoff: "handoff-1",
      pid: process.pid,
      hold: "pid",
    });
    expect(await stateOf(a)).toBe("building");
    // Its hander dead: stale, and cleared.
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(mark, JSON.stringify({ handoff: "handoff-1", pid: dead }));
    expect(await stateOf(a)).toBe("free");
    expect(existsSync(mark)).toBe(false);
  });

  test("a mark naming a hold this code does not know is refused loudly", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const mark = join((await checkoutAdminDir(a))!, SLOT_HANDED_FILE);
    writeFileSync(
      mark,
      JSON.stringify({ handoff: "handoff-1", pid: process.pid, hold: "lease" }),
    );
    let caught: unknown;
    try {
      await readSlotHanded(a);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("names a hold this code does not know");
  });

  test("a hander still holding a claimed handoff neither blocks the next one nor clears its mark", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const one = await markSlotHanded(a, "handoff-1");
    // The build claimed the slot (the mark is gone); its hander still holds.
    await clearSlotHanded(a);
    const two = await markSlotHanded(a, "handoff-2");
    await one.release();
    expect((await readSlotHanded(a))?.handoff).toBe("handoff-2");
    await two.release();
    expect(await readSlotHanded(a)).toBeNull();
  });
});

describe("acquireBuildSlot", () => {
  test("creates a slot when none is free, checked out at the sha", async () => {
    const { root, first } = await repo("repo");
    const got = await acquireBuildSlot(first, {
      repoRoot: root,
      installDeps: noInstall,
      label: "build-1",
    });
    expect(got.created).toBe(true);
    expect(got.waitedOn).toBeNull();
    expect(await git(got.slot, "rev-parse", "HEAD")).toBe(first);
    expect(readFileSync(join(got.slot, "a.txt"), "utf8")).toBe("one\n");
    expect(
      (await readSlotHolders(got.slot)).map((h) => [h.kind, h.label]),
    ).toEqual([["build", "build-1"]]);
    await got.lease.release();
    expect(await readSlotHolders(got.slot)).toEqual([]);
  });

  test("takes the free slot, and makes one only when none is free", async () => {
    const { root, first, second } = await repo("repo");
    const a = await slotAt(root, first);
    const b = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect(b.slot).toBe(a);
    expect(b.created).toBe(false);
    // a is now held by the build: the next build makes a slot.
    const c = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect(c.slot).not.toBe(a);
    expect(c.created).toBe(true);
    await b.lease.release();
    await c.lease.release();
  });

  test("a draining slot (a live holder, no app) is skipped", async () => {
    const { root, first, second } = await repo("repo");
    const a = await slotAt(root, first);
    const reader = await acquireSharedLease(a, "backend", "old");
    const b = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect(b.slot).not.toBe(a);
    expect(b.created).toBe(true);
    expect(await git(a, "rev-parse", "HEAD")).toBe(first);
    await b.lease.release();
    await reader.release();
  });

  test("the least recently served free slot is chosen first", async () => {
    const { root, first, second } = await repo("repo");
    const a = await acquireBuildSlot(first, {
      repoRoot: root,
      installDeps: noInstall,
    });
    const b = await acquireBuildSlot(first, {
      repoRoot: root,
      installDeps: noInstall,
    });
    await a.lease.release();
    await b.lease.release();
    // b stopped serving long ago, a just now.
    const stamp = (at: string) => ({
      at: new Date(at),
      reportAfterMs: THRESHOLD_MS,
    });
    await stampUnserved(b.slot, stamp("2026-01-01T00:00:00Z"));
    await stampUnserved(a.slot, stamp("2026-06-01T00:00:00Z"));
    expect((await listSlots()).map((s) => s.path)).toEqual([b.slot, a.slot]);
    const c = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect(c.slot).toBe(b.slot);
    expect(c.created).toBe(false);
    expect(await git(c.slot, "rev-parse", "HEAD")).toBe(second);
    // Taken for a build: no longer unserved.
    expect(await readUnserved(c.slot)).toBeNull();
    await c.lease.release();
  });

  test("checkout --force clears the slot's leftovers", async () => {
    const { root, first, second } = await repo("repo");
    const a = await slotAt(root, first);
    writeFileSync(join(a, "a.txt"), "leftover\n");
    const b = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect(b.slot).toBe(a);
    expect(readFileSync(join(b.slot, "a.txt"), "utf8")).toBe("two\n");
    expect(await git(b.slot, "status", "--porcelain")).toBe("");
    await b.lease.release();
  });

  test("never builds into a slot an app lives in, even at the same commit", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    await serve(a);
    const b = await acquireBuildSlot(first, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect(b.slot).not.toBe(a);
    expect(b.created).toBe(true);
    await b.lease.release();
  });

  test("past the leak limit it waits on the oldest draining slot and reports its holders", async () => {
    const { root, first, second } = await repo("repo");
    const [a, b] = (await freshSlots(root, first, 2)) as [AppPath, AppPath];
    const readerA = await acquireSharedLease(a, "exec-child", "job.a");
    const readerB = await acquireSharedLease(b, "exec-child", "job.b");
    await stampUnserved(b, {
      at: new Date("2026-06-01T00:00:00Z"),
      reportAfterMs: THRESHOLD_MS,
    });
    await stampUnserved(a, {
      at: new Date("2026-01-01T00:00:00Z"),
      reportAfterMs: THRESHOLD_MS,
    });
    let reported: { draining: HeldSlot[]; waitedOn: AppPath } | null = null;
    let settled = false;
    const waiting = acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
      drainingLimit: 2,
      onExhausted: (draining, waitedOn) => {
        reported = { draining, waitedOn };
      },
    }).then((got) => {
      settled = true;
      return got;
    });
    await Bun.sleep(500);
    expect(settled).toBe(false);
    expect(reported).not.toBeNull();
    expect(reported!.waitedOn).toBe(a);
    expect(
      reported!.draining.map((d) => ({
        slot: d.slot,
        holders: d.holders.map((h) => [h.pid, h.kind, h.label]),
      })),
    ).toEqual([
      { slot: a, holders: [[process.pid, "exec-child", "job.a"]] },
      { slot: b, holders: [[process.pid, "exec-child", "job.b"]] },
    ]);
    await readerA.release();
    const got = await waiting;
    expect(got.slot).toBe(a);
    expect(got.created).toBe(false);
    expect(got.waitedOn).toEqual(reported!.draining);
    expect(await git(got.slot, "rev-parse", "HEAD")).toBe(second);
    await got.lease.release();
    await readerB.release();
    // Under the limit it would have made a third slot instead.
    expect((await listSlots()).length).toBe(2);
  });

  test("a failed checkout releases the lease", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    let caught: unknown;
    try {
      await acquireBuildSlot("0".repeat(40), {
        repoRoot: root,
        installDeps: noInstall,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(await readSlotHolders(a)).toEqual([]);
  });
});

describe("serving apps from slots", () => {
  test("one link per app; serveSlot moves only its own", async () => {
    const { root, first, second } = await repo("repo");
    const a = await slotAt(root, first);
    await serve(a, MAIN);
    await serve(a, SONATA);
    expect(readlinkSync(currentLinkFor(MAIN))).toBe(a);
    expect(readlinkSync(currentLinkFor(SONATA))).toBe(a);
    expect(await servedMainRoot()).toBe(asAppPath(realpathSync(a)));

    const b = await slotAt(root, second);
    await serve(b, MAIN);
    expect(readlinkSync(currentLinkFor(MAIN))).toBe(b);
    expect(readlinkSync(currentLinkFor(SONATA))).toBe(a);
    // sonata still lives in a: not stamped unserved.
    expect(await stateOf(a)).toBe("serving");
    expect(await readUnserved(a)).toBeNull();
    await serve(b, SONATA);
    expect(await stateOf(a)).toBe("free");
    expect(await readUnserved(a)).not.toBeNull();
  });

  test("several apps built together share one slot; their old slots become free after draining", async () => {
    const { root, first, second } = await repo("repo");
    const mainSlot = await slotAt(root, first);
    await serve(mainSlot, MAIN);
    const sonataSlot = await slotAt(root, first);
    await serve(sonataSlot, SONATA);
    expect(sonataSlot).not.toBe(mainSlot);
    const oldBackend = await acquireSharedLease(mainSlot, "backend", MAIN);

    // One build of `second` for main, sonata and website: one slot.
    const built = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
    });
    await built.lease.release();
    for (const ns of [MAIN, SONATA, WEBSITE]) await serve(built.slot, ns);
    expect(
      (await slotStates()).find((s) => s.path === built.slot)!.servedBy.sort(),
    ).toEqual([MAIN, SONATA, WEBSITE].sort());

    expect(await stateOf(mainSlot)).toBe("draining");
    expect(await stateOf(sonataSlot)).toBe("free");
    await oldBackend.release();
    expect(await stateOf(mainSlot)).toBe("free");
  });

  test("the pre-v2 single current link is migrated to main's", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    mkdirSync(dirname(currentLinksDir()), { recursive: true });
    symlinkSync(a, currentLinksDir());
    // Read as main's before the migration.
    expect(await servedSlotOf(MAIN)).toBe(asAppPath(realpathSync(a)));
    expect(await servedSlotOf(SONATA)).toBeNull();
    expect(await stateOf(a)).toBe("serving");
    // `slotStates` migrated it.
    expect(lstatSync(currentLinksDir()).isDirectory()).toBe(true);
    expect(readlinkSync(currentLinkFor(MAIN))).toBe(a);
  });

  test("a failed deploy leaves the link alone; restoring the spec leaves the app where it serves", async () => {
    const { root, first, second } = await repo("repo");
    const a = await slotAt(root, first);
    await serve(a, SONATA);
    const b = await slotAt(root, second);
    // The deploy of sonata from b wrote its spec, then failed: the spec is
    // put back to a (spec-switch's restore); the link was never moved.
    const spec = worktreeArtifacts.spec(SONATA);
    mkdirSync(dirname(spec), { recursive: true });
    writeFileSync(
      spec,
      JSON.stringify({ server: join(b, SERVER_CORE_RELATIVE) }),
    );
    expect(await stateOf(b)).toBe("serving");
    writeFileSync(
      spec,
      JSON.stringify({ server: join(a, SERVER_CORE_RELATIVE) }),
    );
    expect(readlinkSync(currentLinkFor(SONATA))).toBe(a);
    expect(await stateOf(a)).toBe("serving");
    expect(await stateOf(b)).toBe("free");
  });
});

describe("slow drains", () => {
  test("a holder released past the threshold leaves a drain record; one within it does not", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const admin = (await checkoutAdminDir(a))!;
    const drainLog = join(admin, SLOT_DRAIN_LOG_DIR);

    const quick = await acquireSharedLease(a, "exec-child", "quick.job");
    await stampUnserved(a, {
      at: new Date(Date.now() - 2_000),
      reportAfterMs: THRESHOLD_MS,
    });
    await quick.release();
    expect(existsSync(drainLog)).toBe(false);

    const slow = await acquireSharedLease(a, "exec-child", "worktree.prepare");
    await stampUnserved(a, {
      at: new Date(Date.now() - 15_000),
      reportAfterMs: THRESHOLD_MS,
    });
    await slow.release();
    const records = readdirSync(drainLog);
    expect(records).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(drainLog, records[0]!), "utf8"),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      kind: "exec-child",
      label: "worktree.prepare",
      pid: process.pid,
      thresholdMs: THRESHOLD_MS,
      slot: a,
      commit: first,
    });
    expect(record.heldPastSwitchMs as number).toBeGreaterThan(14_000);
  });

  test("the synchronous boot hold notes its release too; a build relay never", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const drainLog = join((await checkoutAdminDir(a))!, SLOT_DRAIN_LOG_DIR);
    await stampUnserved(a, {
      at: new Date(Date.now() - 15_000),
      reportAfterMs: THRESHOLD_MS,
    });
    const relay = holdSlotLeaseSync(a, "build-relay", "build");
    if (relay.kind !== "held") throw new Error("not held");
    relay.release();
    expect(existsSync(drainLog)).toBe(false);
    const child = holdSlotLeaseSync(a, "exec-child", "deps.install");
    if (child.kind !== "held") throw new Error("not held");
    child.release();
    expect(readdirSync(drainLog)).toHaveLength(1);
  });

  test("a lifetime lease notes its end at exit, once", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const drainLog = join((await checkoutAdminDir(a))!, SLOT_DRAIN_LOG_DIR);
    const hold = await holdSlotForLife(a, "backend", MAIN);
    if (hold.kind !== "held") throw new Error("not held");
    await stampUnserved(a, {
      at: new Date(Date.now() - 15_000),
      reportAfterMs: THRESHOLD_MS,
    });
    hold.releaseAtExitSync();
    hold.releaseAtExitSync();
    expect(readdirSync(drainLog)).toHaveLength(1);
    // The record is gone; the lock is the kernel's to drop at exit.
    expect(await readSlotHolders(a)).toEqual([]);
    await hold.lease.release();
    expect(readdirSync(drainLog)).toHaveLength(1);
  });

  test("reclaim files each drain record and deletes it, and reports holders still holding", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const drainLog = join((await checkoutAdminDir(a))!, SLOT_DRAIN_LOG_DIR);
    const slow = await acquireSharedLease(
      a,
      "exec-child",
      "type-check.backstop",
    );
    const stuck = await acquireSharedLease(
      a,
      "exec-child",
      "desktop.fullscreen-budget",
    );
    await stampUnserved(a, {
      at: new Date(Date.now() - 20_000),
      reportAfterMs: THRESHOLD_MS,
    });
    await slow.release();
    expect(readdirSync(drainLog)).toHaveLength(1);

    const reports = collector();
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
    });
    expect(reports.filed.map((r) => [r.label, r.stillHolding]).sort()).toEqual([
      ["desktop.fullscreen-budget", true],
      ["type-check.backstop", false],
    ]);
    expect(readdirSync(drainLog)).toEqual([]);
    await stuck.release();
  });

  test("a holder still holding is judged on awake time: a span the machine slept through is not a slow drain", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const admin = (await checkoutAdminDir(a))!;
    const backstop = await acquireSharedLease(
      a,
      "exec-child",
      "type-check-backstop",
    );
    // Its app switched away two hours ago, before a night of dark wakes:
    // 7 200 s on the wall clock, of which 7 000 s asleep (200 s awake).
    writeFileSync(
      join(admin, SLOT_UNSERVED_FILE),
      renderUnserved({
        at: new Date(Date.now() - 7_200_000).toISOString(),
        reportAfterMs: 300_000,
        asleep: { boot: "boot-1", asleepMs: 1_000_000 },
      }),
    );
    const slept = collector();
    await reclaimSlots({
      drainReportAfterMs: 300_000,
      fileDrainSlow: slept.file,
      asleepNow: { boot: "boot-1", asleepMs: 8_000_000 },
    });
    expect(slept.filed).toEqual([]);

    // The same span awake throughout is reported, with the sleep it saw.
    const awake = collector();
    await reclaimSlots({
      drainReportAfterMs: 300_000,
      fileDrainSlow: awake.file,
      asleepNow: { boot: "boot-1", asleepMs: 1_000_000 },
    });
    expect(
      awake.filed.map((r) => [r.label, r.stillHolding, r.sleptMs]),
    ).toEqual([["type-check-backstop", true, 0]]);

    await backstop.release();
  });

  test("a holder killed past the threshold is reported found dead — its pid reused or not", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const leases = join((await checkoutAdminDir(a))!, SLOT_LEASES_DIR);
    mkdirSync(leases, { recursive: true });
    const killed = (pid: number, label: string): void =>
      writeFileSync(
        join(leases, `${pid}.1.json`),
        JSON.stringify({
          pid,
          kind: "exec-child",
          mode: "shared",
          acquiredAt: new Date().toISOString(),
          label,
        }),
      );
    // SIGKILLed after the switch: records left, no release ran. One pid is
    // now an unrelated live process's.
    await stampUnserved(a, {
      at: new Date(Date.now() - 20_000),
      reportAfterMs: THRESHOLD_MS,
    });
    killed(process.ppid, "reused.job");
    killed(99_999_999, "gone.job");
    const reports = collector();
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
    });
    expect(
      reports.filed.map((r) => [r.label, r.foundDead, r.stillHolding]).sort(),
    ).toEqual([
      ["gone.job", true, false],
      ["reused.job", true, false],
    ]);
    expect(readdirSync(leases).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  test("a holder last seen alive inside the threshold is not reported when found dead", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const leases = join((await checkoutAdminDir(a))!, SLOT_LEASES_DIR);
    mkdirSync(leases, { recursive: true });
    const switchedAt = new Date(Date.now() - 60_000);
    await stampUnserved(a, { at: switchedAt, reportAfterMs: THRESHOLD_MS });
    const record = join(leases, "99999999.1.json");
    writeFileSync(
      record,
      JSON.stringify({
        pid: 99_999_999,
        kind: "backend",
        mode: "shared",
        acquiredAt: new Date().toISOString(),
        label: MAIN,
      }),
    );
    // Last seen alive 2 s after the switch, then SIGKILLed (a shutdown grace).
    const seen = new Date(switchedAt.getTime() + 2_000);
    utimesSync(record, seen, seen);
    const reports = collector();
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
    });
    expect(reports.filed).toEqual([]);
    expect(existsSync(record)).toBe(false);
  });

  test("a holder dead before its slot stopped serving is dropped unreported", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const leases = join((await checkoutAdminDir(a))!, SLOT_LEASES_DIR);
    mkdirSync(leases, { recursive: true });
    writeFileSync(
      join(leases, "99999999.1.json"),
      JSON.stringify({
        pid: 99_999_999,
        kind: "exec-child",
        mode: "shared",
        acquiredAt: new Date().toISOString(),
        label: "early.job",
      }),
    );
    // No stamp yet: this reclaim stamps the slot, and the dead holder's
    // record goes first.
    const reports = collector();
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
    });
    expect(await readUnserved(a)).not.toBeNull();
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
      now: new Date(Date.now() + 60_000),
    });
    expect(reports.filed).toEqual([]);
  });

  test("a record not written to the outbox is kept for the next reclaim", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const drainLog = join((await checkoutAdminDir(a))!, SLOT_DRAIN_LOG_DIR);
    const slow = await acquireSharedLease(a, "exec-child", "deps.install");
    await stampUnserved(a, {
      at: new Date(Date.now() - 20_000),
      reportAfterMs: THRESHOLD_MS,
    });
    await slow.release();
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: async () => false,
    });
    expect(readdirSync(drainLog)).toHaveLength(1);
  });
});

describe("reclaimSlots", () => {
  test("keeps exactly one free slot, the most recently served, and stamps what serves nothing", async () => {
    const { root, first } = await repo("repo");
    const [a, b, c, d] = (await freshSlots(root, first, 4)) as [
      AppPath,
      AppPath,
      AppPath,
      AppPath,
    ];
    await serve(d);
    const held = await acquireSharedLease(c, "backend", "old");
    await stampUnserved(a, {
      at: new Date("2026-01-01T00:00:00Z"),
      reportAfterMs: THRESHOLD_MS,
    });
    await stampUnserved(b, {
      at: new Date("2026-06-01T00:00:00Z"),
      reportAfterMs: THRESHOLD_MS,
    });
    const reports = collector();
    const out = await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
    });
    expect(out.removed).toEqual([a]);
    expect(existsSync(a)).toBe(false);
    expect((await listSlots()).map((s) => s.path).sort()).toEqual(
      [b, c, d].sort(),
    );
    // Unregistered from the repo too.
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(a);
    // The draining one was stamped (now), so its holder is not yet slow.
    expect(await readUnserved(c)).not.toBeNull();
    expect(reports.filed).toEqual([]);
    await held.release();

    // Once c drains too: two free, the older one goes.
    const again = await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
    });
    expect(again.removed).toEqual([b]);
    expect(
      (await slotStates()).map((s) => `${s.path} ${s.state}`).sort(),
    ).toEqual([`${c} free`, `${d} serving`].sort());
  });
});

describe("checkoutRef of a slot", () => {
  function claimMain(checkout: string): void {
    const spec = worktreeArtifacts.spec(MAIN_WORKTREE_NAME);
    mkdirSync(dirname(spec), { recursive: true });
    writeFileSync(
      spec,
      JSON.stringify({ server: join(checkout, SERVER_CORE_RELATIVE) }),
    );
  }

  test("a slot of the repo main is served from is main; another clone's is not", async () => {
    const owner = await repo("owner");
    const other = await repo("other");
    const ownSlot = await acquireBuildSlot(owner.first, {
      repoRoot: owner.root,
      installDeps: noInstall,
    });
    const otherSlot = await acquireBuildSlot(other.first, {
      repoRoot: other.root,
      installDeps: noInstall,
    });
    claimMain(owner.root);
    expect(await checkoutRef(ownSlot.slot)).toEqual({ kind: "main" });
    expect(await checkoutRef(owner.root)).toEqual({ kind: "main" });
    expect(await checkoutRef(otherSlot.slot)).toEqual({
      kind: "worktree",
      name: "slot-2",
    });
    await ownSlot.lease.release();
    await otherSlot.lease.release();
  });

  test("the spec naming a slot claims the whole repo", async () => {
    const owner = await repo("owner");
    const slot = await acquireBuildSlot(owner.first, {
      repoRoot: owner.root,
      installDeps: noInstall,
    });
    claimMain(slot.slot);
    expect(await checkoutRef(owner.root)).toEqual({ kind: "main" });
    expect(await checkoutRef(slot.slot)).toEqual({ kind: "main" });
    // An agent worktree of the same repo is still not main.
    const agent = joinAppPath(dir, "agent-wt");
    await git(owner.root, "worktree", "add", "-q", "-b", "agent", agent);
    expect(await checkoutRef(agent)).toEqual({
      kind: "worktree",
      name: "agent-wt",
    });
    await slot.lease.release();
  });
});

describe("runInBuildSlot and the handed slot", () => {
  afterEach(() => {
    unsetEnv("BUILD_SLOT");
    unsetEnv("BUILD_SLOT_HANDOFF");
  });

  const reclaim = {
    drainReportAfterMs: THRESHOLD_MS,
    fileDrainSlow: collector().file,
  };

  test("the slot is prepared, marked handed, then handed to the build unheld, named in its env; reclaimed after", async () => {
    const { root, first } = await repo("repo");
    const seen = await runInBuildSlot(
      first,
      { repoRoot: root, installDeps: noInstall, reclaim },
      async ({ slot, env }) => ({
        slot,
        env,
        head: await git(slot, "rev-parse", "HEAD"),
        holders: await readSlotHolders(slot),
        state: await stateOf(slot),
      }),
    );
    expect(seen.head).toBe(first);
    expect(seen.holders).toEqual([]);
    expect(seen.state).toBe("building");
    expect(Object.keys(seen.env).sort()).toEqual(
      Object.keys(
        envEntries({ BUILD_SLOT: "x", BUILD_SLOT_HANDOFF: "y" }),
      ).sort(),
    );
    expect(seen.env).toMatchObject(envEntries({ BUILD_SLOT: seen.slot }));
    // The build is over: no mark, and the slot is free (the one kept).
    expect(await stateOf(seen.slot)).toBe("free");
  });

  test("acquireBuildSlot skips a slot handed to a live build", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    await markSlotHanded(a, "handoff-1");
    const b = await acquireBuildSlot(first, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect(b.slot).not.toBe(a);
    await b.lease.release();
  });

  test("the child claims the slot it was handed, by its handoff id; any other is not handed", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    expect((await claimHandedBuildSlot(a, "build-1")).kind).toBe("not-handed");
    await markSlotHanded(a, "handoff-1");
    setEnv("BUILD_SLOT", a);
    setEnv("BUILD_SLOT_HANDOFF", "handoff-1");
    const handed = await claimHandedBuildSlot(a, "build-1");
    if (handed.kind !== "handed") throw new Error("not handed");
    expect(
      (await readSlotHolders(a)).map((h) => [h.kind, h.mode, h.label]),
    ).toEqual([["build", "exclusive", "build-1"]]);
    expect((await claimHandedBuildSlot(root, "build-1")).kind).toBe(
      "not-handed",
    );
    await handed.lease.release();
  });

  test("the child claims a slot handed by a pre-lock hander (the code main serves while it deploys the lock)", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    writeFileSync(
      join((await checkoutAdminDir(a))!, SLOT_HANDED_FILE),
      JSON.stringify({ handoff: "handoff-1", pid: process.pid }),
    );
    setEnv("BUILD_SLOT", a);
    setEnv("BUILD_SLOT_HANDOFF", "handoff-1");
    const handed = await claimHandedBuildSlot(a, "build-1");
    if (handed.kind !== "handed") throw new Error("not handed");
    expect(await readSlotHanded(a)).toBeNull();
    await handed.lease.release();
  });

  test("a slot marked for another handoff is refused loudly", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    await markSlotHanded(a, "handoff-other");
    setEnv("BUILD_SLOT", a);
    setEnv("BUILD_SLOT_HANDOFF", "handoff-1");
    let caught: unknown;
    try {
      await claimHandedBuildSlot(a, "build-1");
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("another build may have taken it");
  });

  test("a handed slot found held is refused loudly", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const reader = await acquireSharedLease(a, "backend", MAIN);
    await markSlotHanded(a, "handoff-1");
    setEnv("BUILD_SLOT", a);
    setEnv("BUILD_SLOT_HANDOFF", "handoff-1");
    let caught: unknown;
    try {
      await claimHandedBuildSlot(a, "build-1");
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain(
      "nothing may hold a slot a build was handed",
    );
    await reader.release();
  });

  test("the handover: a backend's boot lease waits behind the build, and is granted once the build turns its lease shared", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const build = await tryExclusiveLease(a, "build", "build-1");
    if (build.kind !== "acquired") throw new Error("not acquired");
    let granted = false;
    const backend = acquireSharedLease(a, "backend", MAIN).then((l) => {
      granted = true;
      return l;
    });
    await Bun.sleep(500);
    // Without the handover this is the deadlock: the backend waits for the
    // build, which waits for the backend's health.
    expect(granted).toBe(false);
    await build.lease.downgrade();
    const lease = await backend;
    expect(granted).toBe(true);
    expect(
      (await readSlotHolders(a)).map((h) => [h.kind, h.mode]).sort(),
    ).toEqual([
      ["backend", "shared"],
      ["build", "shared"],
    ]);
    // Still held by both: no build can take the slot.
    expect((await tryExclusiveLease(a, "build", "build-2")).kind).toBe("held");
    await lease.release();
    await build.lease.release();
    const next = await tryExclusiveLease(a, "build", "build-2");
    expect(next.kind).toBe("acquired");
    if (next.kind === "acquired") await next.lease.release();
  });
});

describe("lifetime and boot leases", () => {
  test("holdSlotForLife holds a slot and nothing else", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    expect((await holdSlotForLife(root, "backend", MAIN)).kind).toBe(
      "not-a-slot",
    );
    const held = await holdSlotForLife(a, "backend", MAIN);
    expect(held.kind).toBe("held");
    expect((await tryExclusiveLease(a, "build", "b")).kind).toBe("held");
    if (held.kind === "held") await held.lease.release();
  });

  test("the synchronous boot lease (a blocking shared flock) is the same lock, with a record", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    expect(holdSlotLeaseSync(root, "exec-child", "x").kind).toBe("not-a-slot");
    const hold = holdSlotLeaseSync(a, "agent-boot", "agent-host");
    if (hold.kind !== "held") throw new Error("not held");
    expect(
      (await readSlotHolders(a)).map((h) => [h.pid, h.kind, h.mode, h.label]),
    ).toEqual([[process.pid, "agent-boot", "shared", "agent-host"]]);
    // It shares with an in-process shared lease, and keeps a build out.
    const other = await acquireSharedLease(a, "backend", MAIN);
    expect((await tryExclusiveLease(a, "build", "b")).kind).toBe("held");
    await other.release();
    expect((await tryExclusiveLease(a, "build", "b")).kind).toBe("held");
    // Released once loaded (the agent host's boot), it is gone.
    hold.release();
    expect(await readSlotHolders(a)).toEqual([]);
    const build = await tryExclusiveLease(a, "build", "b");
    expect(build.kind).toBe("acquired");
    if (build.kind === "acquired") await build.lease.release();
  });

  test("a dead holder's record is skipped and pruned; one without a label reads as null", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const admin = (await checkoutAdminDir(a))!;
    const leases = join(admin, SLOT_LEASES_DIR);
    mkdirSync(leases, { recursive: true });
    // A pid no process has (pids are far below this on macOS).
    const dead = join(leases, "99999999.1.json");
    writeFileSync(
      dead,
      JSON.stringify({
        pid: 99_999_999,
        kind: "exec-child",
        mode: "shared",
        acquiredAt: new Date().toISOString(),
      }),
    );
    expect(await readSlotHolders(a)).toEqual([]);
    expect(existsSync(dead)).toBe(false);
    // The guard bootstrap's copy writes no label.
    writeFileSync(
      join(leases, `${process.pid}.g1.json`),
      JSON.stringify({
        pid: process.pid,
        kind: "guard",
        mode: "shared",
        acquiredAt: new Date().toISOString(),
      }),
    );
    expect((await readSlotHolders(a)).map((h) => h.label)).toEqual([null]);
  });
});

describe("review fixes", () => {
  test("an adopted deploy: the link moves to the new slot, the spec keeps the old one serving", async () => {
    const { root, first, second } = await repo("repo");
    const old = await slotAt(root, first);
    await serve(old, MAIN);
    const spec = worktreeArtifacts.spec(MAIN);
    mkdirSync(dirname(spec), { recursive: true });
    writeFileSync(
      spec,
      JSON.stringify({ server: join(old, SERVER_CORE_RELATIVE) }),
    );
    // The new build's backend adopted (identical backend code): the spec
    // still names `old`, the link moves to `next`.
    const next = await slotAt(root, second);
    await serve(next, MAIN);
    expect(readlinkSync(currentLinkFor(MAIN))).toBe(next);
    expect(await servedMainRoot()).toBe(asAppPath(realpathSync(next)));
    expect(await stateOf(old)).toBe("serving");
    expect(await stateOf(next)).toBe("serving");
    expect(await readUnserved(old)).toBeNull();
    // Never built into while the running backend lives there.
    const b = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect([old, next]).not.toContain(b.slot);
    await b.lease.release();
    // Once a later deploy restarts the backend onto `next`, `old` drains.
    writeFileSync(
      spec,
      JSON.stringify({ server: join(next, SERVER_CORE_RELATIVE) }),
    );
    await serve(next, MAIN);
    expect(await stateOf(old)).toBe("free");
    expect(await readUnserved(old)).not.toBeNull();
  });

  test("a record naming a live pid does not hold a slot whose lock is unheld (pid reuse)", async () => {
    const { root, first } = await repo("repo");
    const a = await slotAt(root, first);
    const leases = join((await checkoutAdminDir(a))!, SLOT_LEASES_DIR);
    mkdirSync(leases, { recursive: true });
    // A SIGKILLed holder whose pid now belongs to an unrelated live process.
    writeFileSync(
      join(leases, `${process.ppid}.1.json`),
      JSON.stringify({
        pid: process.ppid,
        kind: "backend",
        mode: "shared",
        acquiredAt: new Date().toISOString(),
        label: MAIN,
      }),
    );
    const s = (await slotStates()).find((x) => x.path === a)!;
    expect(s.state).toBe("free");
    expect(s.lock).toBe("unheld");
    expect(s.holders).toEqual([]);
    // Held for real, the lock decides, and the records name who.
    const reader = await acquireSharedLease(a, "exec-child", "job.x");
    const held = (await slotStates()).find((x) => x.path === a)!;
    expect(held.state).toBe("draining");
    expect(held.lock).toBe("shared");
    expect(held.holders.map((h) => h.label)).toContain("job.x");
    await reader.release();
    const build = await tryExclusiveLease(a, "build", "b");
    if (build.kind !== "acquired") throw new Error("not acquired");
    expect(await stateOf(a)).toBe("building");
    await build.lease.release();
  });

  test("pool steps are serialized: a state read waits for a holder of the pool lock", async () => {
    const { root, first } = await repo("repo");
    await slotAt(root, first);
    const order: string[] = [];
    const holder = withSlotPool(async () => {
      order.push("held");
      await Bun.sleep(300);
      order.push("released");
    });
    await Bun.sleep(20);
    const read = slotStates().then(() => order.push("read"));
    await Promise.all([holder, read]);
    expect(order).toEqual(["held", "released", "read"]);
  });

  test("reclaim beside concurrent builds and state reads never fails on a vanished slot", async () => {
    const { root, first } = await repo("repo");
    await freshSlots(root, first, 4);
    const reports = collector();
    const results = await Promise.all([
      reclaimSlots({
        drainReportAfterMs: THRESHOLD_MS,
        fileDrainSlow: reports.file,
      }),
      slotStates(),
      slotStates(),
      acquireBuildSlot(first, { repoRoot: root, installDeps: noInstall }),
      slotStates(),
    ]);
    const built = results[3];
    expect(await stateOf(built.slot)).toBe("building");
    await built.lease.release();
  });

  test("a slot reclaimed between the listing and its read is skipped, not an error", async () => {
    const { root, first } = await repo("repo");
    const [a] = await freshSlots(root, first, 1);
    // What a lock-free reader can meet: the dir gone after `readdir`.
    rmSync(a!, { recursive: true, force: true });
    expect(await listSlots()).toEqual([]);
  });

  test("reclaim drops only the removed slot's registration, never another prunable entry", async () => {
    const { root, first } = await repo("repo");
    const [a, b] = (await freshSlots(root, first, 2)) as [AppPath, AppPath];
    // An unrelated checkout whose dir is gone: prunable, but not ours.
    const other = joinAppPath(dir, "other-wt");
    await git(root, "worktree", "add", "-q", "--detach", other, first);
    rmSync(other, { recursive: true, force: true });
    const entries = (): string[] =>
      readdirSync(join(root, ".git", "worktrees")).sort();
    const before = entries();
    expect(before).toHaveLength(3);
    const out = await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: collector().file,
    });
    expect(out.removed).toHaveLength(1);
    const removed = out.removed[0]!;
    expect([a, b]).toContain(removed);
    expect(entries()).toHaveLength(2);
    expect(entries()).toContain("other-wt");
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(
      removed,
    );
  });

  test("past the leak limit, the slot this process runs from is never waited on", async () => {
    const { root, first, second } = await repo("repo");
    const [own] = (await freshSlots(root, first, 1)) as [AppPath];
    const relay = await acquireSharedLease(own, "build-relay", "build");
    let exhausted = false;
    const got = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
      drainingLimit: 1,
      ownRoot: own,
      onExhausted: () => {
        exhausted = true;
      },
    });
    expect(exhausted).toBe(false);
    expect(got.created).toBe(true);
    expect(got.slot).not.toBe(own);
    await got.lease.release();
    await relay.release();
  });

  test("a leak-limit wait is reported again while it lasts", async () => {
    const { root, first, second } = await repo("repo");
    const [a] = (await freshSlots(root, first, 1)) as [AppPath];
    const reader = await acquireSharedLease(a, "exec-child", "job.a");
    const waits: number[] = [];
    const waiting = acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
      drainingLimit: 1,
      exhaustedRefileMs: 150,
      onExhausted: (_draining, waitedOn, waitingMs) => {
        expect(waitedOn).toBe(a);
        waits.push(waitingMs);
      },
    });
    await Bun.sleep(600);
    expect(waits[0]).toBe(0);
    expect(waits.length).toBeGreaterThanOrEqual(3);
    expect(waits.at(-1)!).toBeGreaterThan(0);
    await reader.release();
    const got = await waiting;
    expect(got.slot).toBe(a);
    await got.lease.release();
  });

  test("a reclaim's slow delete runs outside the pool lock: link flips and state reads go on", async () => {
    const { root, first } = await repo("repo");
    const [a, b, c] = (await freshSlots(root, first, 3)) as [
      AppPath,
      AppPath,
      AppPath,
    ];
    let deleting!: () => void;
    const started = new Promise<void>((r) => (deleting = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const reclaim = reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: collector().file,
      removeTree: async (path) => {
        deleting();
        await gate;
        rmSync(path, { recursive: true, force: true });
      },
    });
    await started;
    // The pool lock is free while the delete runs.
    const t0 = Date.now();
    await withSlotPool(async () => {});
    expect(Date.now() - t0).toBeLessThan(1_000);
    const kept = (await listSlots()).map((s) => s.path);
    expect(kept).toHaveLength(1);
    await serve(kept[0]!);
    expect(await stateOf(kept[0]!)).toBe("serving");
    finish();
    const out = await reclaim;
    expect(out.removed).toHaveLength(2);
    expect([a, b, c]).toEqual(
      expect.arrayContaining([...out.removed, kept[0]]),
    );
    // Nothing left behind: no trash, no claim, no registration of a removed slot.
    expect(
      readdirSync(dirname(a)).filter((n) => n.startsWith(".trash-")),
    ).toEqual([]);
    const listed = await git(root, "worktree", "list", "--porcelain");
    for (const r of out.removed) expect(listed).not.toContain(r);
  });

  test("a slot is made outside the pool lock and appears whole, registered at its own path", async () => {
    const { root, first } = await repo("repo");
    const made = await acquireBuildSlot(first, {
      repoRoot: root,
      installDeps: noInstall,
    });
    expect(made.created).toBe(true);
    expect(made.slot).toBe(
      joinAppPath(asAppPath(dirname(made.slot)), "slot-1"),
    );
    expect(await git(made.slot, "rev-parse", "HEAD")).toBe(first);
    const listed = await git(root, "worktree", "list", "--porcelain");
    expect(listed).toContain(`worktree ${made.slot}\n`);
    expect(listed).not.toContain(".staging");
    expect(readdirSync(join(dirname(made.slot), ".staging"))).toEqual([]);
    await made.lease.release();
  });

  test("the sweep deletes a staging dir a killed maker left, with its registration", async () => {
    const { root, first } = await repo("repo");
    const [a] = (await freshSlots(root, first, 1)) as [AppPath];
    // A maker killed after its add: an unclaimed, registered staging checkout.
    const staging = join(dirname(a), ".staging", "slot-dead");
    mkdirSync(dirname(staging), { recursive: true });
    await git(root, "worktree", "add", "-q", "--detach", staging, first);
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: collector().file,
    });
    expect(existsSync(staging)).toBe(false);
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(
      "slot-dead",
    );
    expect((await listSlots()).map((s) => s.path)).toEqual([a]);
  });

  test("a leak-limit wait re-checks the slot it was granted: one made to serve meanwhile is let go", async () => {
    const { root, first, second } = await repo("repo");
    const [a] = (await freshSlots(root, first, 1)) as [AppPath];
    const reader = await acquireSharedLease(a, "exec-child", "job.a");
    const waiting = acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
      drainingLimit: 1,
      onExhausted: () => {},
      // What changed during the wait: an app moved into the slot.
      afterWait: async (slot) => {
        expect(slot).toBe(a);
        await serve(a, SONATA);
      },
    });
    await Bun.sleep(300);
    await reader.release();
    const got = await waiting;
    expect(got.slot).not.toBe(a);
    expect(got.created).toBe(true);
    expect(await stateOf(a)).toBe("serving");
    // The served slot was let go: its lock is free for the app's processes.
    const probe = await tryExclusiveLease(a, "build", "probe");
    expect(probe.kind).toBe("acquired");
    if (probe.kind === "acquired") await probe.lease.release();
    await got.lease.release();
  });
});

describe("central pins its slot", () => {
  // Central keeps the slot it booted from until a deploy restarts it, and its
  // spec is no proof of where it runs (a build on a pre-slots branch rewrites
  // it to the repo root): its slot serves while it holds it, never drains.

  /** A slot central runs from, its spec naming another tree (no link, no spec names it). */
  async function centralSlot(
    root: AppPath,
    sha: string,
  ): Promise<{
    slot: AppPath;
    central: Awaited<ReturnType<typeof acquireSharedLease>>;
  }> {
    const slot = await slotAt(root, sha);
    const central = await acquireSharedLease(slot, "central", "central");
    // Stamped by a reader that did not know central pins it: an old stamp
    // must not make it a drain either.
    await stampUnserved(slot, {
      at: new Date(Date.now() - 60_000),
      reportAfterMs: THRESHOLD_MS,
    });
    return { slot, central };
  }

  test("central's slot serves, pinned by central, whatever links and specs say", async () => {
    const { root, first } = await repo("repo");
    const { slot, central } = await centralSlot(root, first);
    const s = (await slotStates()).find((x) => x.path === slot)!;
    expect(s.state).toBe("serving");
    expect(s.servedBy).toEqual([]);
    expect(s.pinnedBy.map((h) => [h.kind, h.label])).toEqual([
      ["central", "central"],
    ]);
    await central.release();
    expect(await stateOf(slot)).toBe("free");
  });

  test("a deploy is not blocked by central plus two short drains", async () => {
    const { root, first, second } = await repo("repo");
    const { slot: c, central } = await centralSlot(root, first);
    const [a, b] = (await freshSlots(root, first, 2)) as [AppPath, AppPath];
    const jobA = await acquireSharedLease(a, "exec-child", "run");
    const jobB = await acquireSharedLease(
      b,
      "exec-child",
      "worktree.spare-refill",
    );
    for (const s of [a, b])
      await stampUnserved(s, { at: new Date(), reportAfterMs: THRESHOLD_MS });
    expect(await stateOf(c)).toBe("serving");
    expect(await stateOf(a)).toBe("draining");
    expect(await stateOf(b)).toBe("draining");

    // The default leak limit (3): two drains are under it, so a slot is made.
    let exhausted = false;
    const got = await acquireBuildSlot(second, {
      repoRoot: root,
      installDeps: noInstall,
      onExhausted: () => {
        exhausted = true;
      },
    });
    expect(exhausted).toBe(false);
    expect(got.created).toBe(true);
    expect([c, a, b]).not.toContain(got.slot);
    await got.lease.release();
    await jobA.release();
    await jobB.release();
    await central.release();
  });

  test("central is never reported as a slow drain, holding or released", async () => {
    const { root, first } = await repo("repo");
    const { slot, central } = await centralSlot(root, first);
    const reports = collector();
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
    });
    expect(reports.filed).toEqual([]);
    expect(await stateOf(slot)).toBe("serving");
    // The stale stamp is gone: a co-holder's release is no slow drain.
    expect(await readUnserved(slot)).toBeNull();
    const job = await acquireSharedLease(slot, "exec-child", "run");
    await job.release();
    await central.release();
    const drainLog = join((await checkoutAdminDir(slot))!, SLOT_DRAIN_LOG_DIR);
    expect(existsSync(drainLog)).toBe(false);
  });

  test("a drain record a central on older code left at its exit is dropped, never filed", async () => {
    const { root, first } = await repo("repo");
    const slot = await slotAt(root, first);
    const drainLog = join((await checkoutAdminDir(slot))!, SLOT_DRAIN_LOG_DIR);
    mkdirSync(drainLog, { recursive: true });
    const record = (kind: "central" | "exec-child", pid: number): string =>
      renderDrainRecord({
        kind,
        label: kind,
        pid,
        heldPastSwitchMs: 134_000,
        sleptMs: null,
        thresholdMs: THRESHOLD_MS,
        slot,
        commit: first,
        releasedAt: new Date().toISOString(),
        foundDead: false,
      });
    writeFileSync(join(drainLog, "1.0.json"), record("central", 1));
    writeFileSync(join(drainLog, "2.0.json"), record("exec-child", 2));
    const reports = collector();
    await reclaimSlots({
      drainReportAfterMs: THRESHOLD_MS,
      fileDrainSlow: reports.file,
    });
    expect(reports.filed.map((r) => r.kind)).toEqual(["exec-child"]);
    expect(readdirSync(drainLog)).toEqual([]);
  });
});
