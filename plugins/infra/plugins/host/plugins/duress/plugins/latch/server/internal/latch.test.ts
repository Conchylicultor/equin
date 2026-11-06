import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setClockForTests,
  _setLatchDirForTests,
  clearDuress,
  duressEpisode,
  FRESHNESS_LEASE_MS,
  isUnderDuress,
  LATCH_FILENAME,
  MEMO_TTL_MS,
  readDuress,
  readFreshDuress,
  refreshDuress,
  setDuress,
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

function backdateLatch(ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(latchFile(), t, t);
}

describe("setDuress / isUnderDuress", () => {
  test("no latch → not under duress", () => {
    expect(isUnderDuress()).toBe(false);
  });

  test("set → under duress, with a readable payload", () => {
    const before = Date.now();
    setDuress("event-loop cluster onset");
    expect(isUnderDuress()).toBe(true);
    const latch = readDuress();
    expect(latch).not.toBeNull();
    expect(latch!.reason).toBe("event-loop cluster onset");
    expect(latch!.setAt).toBeGreaterThanOrEqual(before);
    expect(latch!.setAt).toBeLessThanOrEqual(Date.now());
  });

  test("set overwrites a previous episode", () => {
    setDuress("first");
    setDuress("second");
    expect(readDuress()!.reason).toBe("second");
  });

  test("stale mtime (past the freshness lease) → duress lapsed", () => {
    setDuress("crashed sentinel");
    backdateLatch(FRESHNESS_LEASE_MS + 1_000);
    expect(isUnderDuress()).toBe(false);
  });
});

describe("refreshDuress", () => {
  test("refresh bumps a stale latch back to fresh", () => {
    setDuress("long episode");
    backdateLatch(FRESHNESS_LEASE_MS + 1_000);
    expect(isUnderDuress()).toBe(false);
    refreshDuress();
    expect(isUnderDuress()).toBe(true);
  });

  test("refresh when absent throws — refresh without set is a lifecycle bug", () => {
    expect(() => refreshDuress()).toThrow(/no latch/);
  });
});

describe("clearDuress", () => {
  test("clear ends the episode immediately (memo invalidated)", () => {
    setDuress("episode");
    expect(isUnderDuress()).toBe(true);
    clearDuress();
    expect(isUnderDuress()).toBe(false);
    expect(existsSync(latchFile())).toBe(false);
    expect(readDuress()).toBeNull();
  });

  test("clear is idempotent — twice, and with no latch ever set", () => {
    expect(() => clearDuress()).not.toThrow();
    setDuress("episode");
    clearDuress();
    expect(() => clearDuress()).not.toThrow();
  });
});

describe("duressEpisode", () => {
  test("no latch → null; set → the setAt; new set → the new setAt immediately", () => {
    let t = Date.now();
    _setClockForTests(() => t);

    expect(duressEpisode()).toBeNull();
    setDuress("one");
    expect(duressEpisode()).toBe(t);
    t += 5;
    setDuress("two"); // mutation invalidates the memo — no TTL blind spot
    expect(duressEpisode()).toBe(t);
    clearDuress();
    expect(duressEpisode()).toBeNull();
  });

  test("memoized within the TTL window; past it, re-read sees truth", () => {
    let t = Date.now();
    _setClockForTests(() => t);

    setDuress("episode");
    const setAt = duressEpisode(); // fills the memo at t
    expect(setAt).toBe(t);

    rmSync(latchFile()); // behind the API's back — a memoized read must not see it
    t += MEMO_TTL_MS - 1;
    expect(duressEpisode()).toBe(setAt!);

    t += 2; // past the TTL
    expect(duressEpisode()).toBeNull();
  });
});

describe("memo TTL", () => {
  test("within the TTL window the stat is memoized; past it, re-stat sees truth", () => {
    let t = Date.now();
    _setClockForTests(() => t);

    setDuress("memoized episode");
    expect(isUnderDuress()).toBe(true); // fills the memo at t

    // Remove the file behind the API's back — a memoized read must not see it.
    rmSync(latchFile());
    t += MEMO_TTL_MS - 1;
    expect(isUnderDuress()).toBe(true); // still inside the memo window

    t += 2; // now past the TTL
    expect(isUnderDuress()).toBe(false); // re-stat observes the missing latch
  });

  test("mutations invalidate the memo — no 2 s blind spot after set", () => {
    let t = Date.now();
    _setClockForTests(() => t);

    expect(isUnderDuress()).toBe(false); // memoizes false at t
    setDuress("fresh episode");
    expect(isUnderDuress()).toBe(true); // set cleared the memo — true immediately
  });
});

describe("readFreshDuress", () => {
  test("null with no latch, the payload while fresh, null once lapsed", async () => {
    expect(await readFreshDuress()).toBeNull();
    setDuress("load");
    expect((await readFreshDuress())?.reason).toBe("load");
    backdateLatch(FRESHNESS_LEASE_MS + 1_000);
    expect(await readFreshDuress()).toBeNull();
  });

  test("sees a latch set after isUnderDuress memoized 'no'", async () => {
    expect(isUnderDuress()).toBe(false);
    // Another process sets it: this process's memo is not invalidated.
    writeFileSync(
      latchFile(),
      JSON.stringify({ setAt: Date.now(), reason: "elsewhere" }),
    );
    expect((await readFreshDuress())?.reason).toBe("elsewhere");
  });
});
