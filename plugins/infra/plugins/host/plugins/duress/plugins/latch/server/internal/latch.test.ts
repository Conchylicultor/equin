import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rename, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _breakLatchWatchForTests,
  _nextLatchReadForTests,
  _setClockForTests,
  _setLatchDirForTests,
  clearDuress,
  duressEpisode,
  duressLatchFaultSink,
  FRESHNESS_LEASE_MS,
  isUnderDuress,
  LATCH_FILENAME,
  readDuress,
  readFreshDuress,
  refreshDuress,
  setDuress,
  watchDuress,
} from "./latch";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

let dir: AppPath;
beforeEach(() => {
  dir = asAppPath(mkdtempSync(join(tmpdir(), "duress-")));
  _setLatchDirForTests(dir);
});
afterEach(() => {
  _setLatchDirForTests(null);
  _setClockForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const latchFile = (): string => join(dir, LATCH_FILENAME);

/** Another process's write: straight to the file, behind this module's back. */
async function writeElsewhere(reason: string, setAt = Date.now()) {
  const tmp = `${latchFile()}.elsewhere.tmp`;
  await writeFile(tmp, JSON.stringify({ setAt, reason }));
  await rename(tmp, latchFile());
}

async function backdateLatch(ageMs: number): Promise<void> {
  const t = (Date.now() - ageMs) / 1000;
  await utimes(latchFile(), t, t);
}

describe("own writes: the writer reads its own write at once", () => {
  test("no latch → not under duress", async () => {
    await watchDuress();
    expect(isUnderDuress()).toBe(false);
    expect(duressEpisode()).toBeNull();
  });

  test("set → under duress, with a readable payload", async () => {
    const before = Date.now();
    const written = await setDuress("event-loop cluster onset");
    expect(isUnderDuress()).toBe(true);
    expect(duressEpisode()).toBe(written.setAt);
    const reading = await readDuress();
    expect(reading).toEqual({ latch: written, fresh: true });
    expect(written.reason).toBe("event-loop cluster onset");
    expect(written.setAt).toBeGreaterThanOrEqual(before);
    expect(written.setAt).toBeLessThanOrEqual(Date.now());
  });

  test("set overwrites a previous episode; the episode id follows at once", async () => {
    let t = Date.now();
    _setClockForTests(() => t);
    await setDuress("first");
    expect(duressEpisode()).toBe(t);
    t += 5;
    await setDuress("second");
    expect(duressEpisode()).toBe(t);
    expect((await readDuress())?.latch.reason).toBe("second");
  });

  test("clear ends the episode immediately", async () => {
    await setDuress("episode");
    expect(isUnderDuress()).toBe(true);
    await clearDuress();
    expect(isUnderDuress()).toBe(false);
    expect(duressEpisode()).toBeNull();
    expect(existsSync(latchFile())).toBe(false);
    expect(await readDuress()).toBeNull();
  });

  test("clear is idempotent — twice, and with no latch ever set", async () => {
    await clearDuress();
    await setDuress("episode");
    await clearDuress();
    await clearDuress();
    expect(isUnderDuress()).toBe(false);
  });
});

describe("the lease: lapse is judged from the held mtime against the clock", () => {
  test("lapses with no file event once the lease runs out", async () => {
    let t = Date.now();
    _setClockForTests(() => t);
    await setDuress("crashed sentinel");
    t += FRESHNESS_LEASE_MS - 1;
    expect(isUnderDuress()).toBe(true);
    t += 1;
    expect(isUnderDuress()).toBe(false);
    // The episode still exists (the file is there) — only its lease lapsed.
    expect(duressEpisode()).not.toBeNull();
  });

  test("refresh renews the lease", async () => {
    let t = Date.now();
    _setClockForTests(() => t);
    await setDuress("long episode");
    t += FRESHNESS_LEASE_MS + 1_000;
    expect(isUnderDuress()).toBe(false);
    await refreshDuress();
    expect(isUnderDuress()).toBe(true);
  });

  test("refresh when absent throws — refresh without set is a lifecycle bug", () => {
    expect(refreshDuress()).rejects.toThrow(/no latch/);
  });
});

describe("other processes' writes reach the gate through the watch", () => {
  test("a latch set elsewhere is picked up, then its clear", async () => {
    await watchDuress();
    expect(isUnderDuress()).toBe(false);

    const read = _nextLatchReadForTests();
    await writeElsewhere("elsewhere", 1234);
    await read;
    expect(isUnderDuress()).toBe(true);
    expect(duressEpisode()).toBe(1234);

    const cleared = _nextLatchReadForTests();
    await unlink(latchFile());
    await cleared;
    expect(isUnderDuress()).toBe(false);
    expect(duressEpisode()).toBeNull();
  });

  test("an existing latch is read when the watch starts", async () => {
    await writeElsewhere("before boot", 42);
    await watchDuress();
    expect(duressEpisode()).toBe(42);
    expect(isUnderDuress()).toBe(true);
  });

  test("not known yet answers 'not under duress', then the first read lands", async () => {
    await writeElsewhere("before the first gate read");
    // The first gate read starts the watch; the answer is the stand-in.
    expect(isUnderDuress()).toBe(false);
    await watchDuress();
    expect(isUnderDuress()).toBe(true);
  });
});

describe("readFreshDuress", () => {
  test("null with no latch, the payload while fresh, null once lapsed", async () => {
    expect(await readFreshDuress()).toBeNull();
    await setDuress("load");
    expect((await readFreshDuress())?.reason).toBe("load");
    await backdateLatch(FRESHNESS_LEASE_MS + 1_000);
    expect(await readFreshDuress()).toBeNull();
    expect((await readDuress())?.fresh).toBe(false);
  });

  test("sees a latch set elsewhere before the watch hears it", async () => {
    await watchDuress();
    await writeElsewhere("elsewhere");
    expect((await readFreshDuress())?.reason).toBe("elsewhere");
  });
});

describe("the latch's own failures are reported, never thrown; a later gate read re-arms", () => {
  let reports: string[];
  beforeEach(() => {
    reports = [];
    duressLatchFaultSink.register((r) => reports.push(r.message));
  });
  afterEach(() => {
    duressLatchFaultSink.register(null);
  });

  test("a watch that fails to open is retried by a gate read after the re-arm delay", async () => {
    let t = Date.now();
    _setClockForTests(() => t);
    // The latch dir sits under a regular file: mkdir fails (ENOTDIR).
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const broken = asAppPath(join(blocker, "duress"));
    _setLatchDirForTests(broken);

    await watchDuress(); // resolves — the failure is reported, not thrown
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("opening the watch");

    // The directory becomes watchable, and holds a latch.
    rmSync(blocker);
    mkdirSync(broken, { recursive: true });
    await writeFile(
      join(broken, LATCH_FILENAME),
      JSON.stringify({ setAt: t, reason: "after the failure" }),
    );

    // Inside the re-arm delay a gate read does not retry.
    expect(isUnderDuress()).toBe(false);
    await Bun.sleep(50);
    expect(isUnderDuress()).toBe(false);
    expect(reports).toHaveLength(1);

    // Past it, the next gate read re-arms and the latch is read.
    t += 5_000;
    expect(isUnderDuress()).toBe(false); // starts the re-arm
    await watchDuress(); // joins it
    expect(isUnderDuress()).toBe(true);
    expect(reports).toHaveLength(1);
  });

  test("a watch that breaks is reported, keeps the held copy, and re-arms", async () => {
    let t = Date.now();
    _setClockForTests(() => t);
    await writeElsewhere("before the break", t);
    await watchDuress();
    expect(isUnderDuress()).toBe(true);

    // The platform reports the watch broken: nothing is thrown at the emitter.
    _breakLatchWatchForTests(new Error("watch broke"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("watch broke");
    expect(isUnderDuress()).toBe(true); // the held copy, still on its lease

    await unlink(latchFile()); // unheard: the watch is gone
    expect(isUnderDuress()).toBe(true);

    t += 5_000;
    expect(isUnderDuress()).toBe(true); // starts the re-arm
    await watchDuress();
    expect(isUnderDuress()).toBe(false); // re-read: the latch is gone
  });

  test("a corrupt latch is reported and the held copy kept", async () => {
    await writeElsewhere("good", 7);
    await watchDuress();
    expect(duressEpisode()).toBe(7);
    const read = _nextLatchReadForTests();
    await writeFile(latchFile(), "{not json");
    await read;
    expect(duressEpisode()).toBe(7);
    expect(reports.some((m) => m.includes("re-reading"))).toBe(true);
  });
});
