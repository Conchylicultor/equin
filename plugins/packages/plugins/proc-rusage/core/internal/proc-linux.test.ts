import { describe, expect, test } from "bun:test";
import {
  parseProcStat,
  procRusageFromProcfs,
  readLinuxProcRusage,
  readLinuxProcRusageSync,
} from "./proc-linux";

// The procfs files of a bun process, in the kernel's format, trimmed (values made up).
const SMAPS_ROLLUP = `55d2c8a4b000-7ffd2a1f2000 ---p 00000000 00:00 0                          [rollup]
Rss:              120000 kB
Pss:               98000 kB
Pss_Dirty:         70000 kB
Pss_Anon:          65000 kB
Pss_File:          30000 kB
Pss_Shmem:          3000 kB
Shared_Clean:      40000 kB
Shared_Dirty:          0 kB
Private_Clean:     10000 kB
Private_Dirty:     70000 kB
Referenced:       120000 kB
Anonymous:         70000 kB
Swap:                  0 kB
SwapPss:               0 kB
`;

const STATUS = `Name:\tbun
State:\tS (sleeping)
VmPeak:\t72000000 kB
VmSize:\t71000000 kB
VmHWM:\t  250000 kB
VmRSS:\t  120000 kB
RssAnon:\t   70000 kB
RssFile:\t   45000 kB
RssShmem:\t    5000 kB
Threads:\t12
`;

// comm with a space and a parenthesis: fields start after the LAST ')'.
const STAT =
  "4242 (bun (x) y) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 30 7 3 20 0 12 0 5000 0 0";

function read(texts: Parameters<typeof procRusageFromProcfs>[0]) {
  const r = procRusageFromProcfs(texts);
  if (r.kind !== "read") throw new Error(r.kind);
  return r;
}

describe("procRusageFromProcfs", () => {
  test("proportional: Pss_Anon + Pss_Shmem; the peak adds what the resident size gave back since its peak", () => {
    const r = read({ smapsRollup: SMAPS_ROLLUP, status: STATUS, stat: STAT });
    expect(r.memory).toEqual({
      physFootprintBytes: (65000 + 3000) * 1024,
      residentSizeBytes: 120000 * 1024,
      peakPhysFootprintBytes: (65000 + 3000 + (250000 - 120000)) * 1024,
      sharedPages: "proportional",
    });
    // utime 250 + stime 30 ticks; cutime 7 + cstime 3; starttime 5000.
    expect(r.cpu).toEqual({ ownNs: 280 * 1e7, reapedChildrenNs: 10 * 1e7 });
    expect(r.startedNs).toBe(5000 * 1e7);
  });

  test("counted (no rollup): RssAnon + RssShmem, shared pages whole", () => {
    const r = read({ status: STATUS, stat: STAT });
    expect(r.memory).toEqual({
      physFootprintBytes: (70000 + 5000) * 1024,
      residentSizeBytes: 120000 * 1024,
      peakPhysFootprintBytes: (70000 + 5000 + (250000 - 120000)) * 1024,
      sharedPages: "whole",
    });
  });

  test("the peak is never below the memory now", () => {
    const r = read({
      smapsRollup: SMAPS_ROLLUP,
      status: STATUS.replace("VmHWM:\t  250000", "VmHWM:\t  110000"),
      stat: STAT,
    });
    expect(r.memory.peakPhysFootprintBytes).toBe((65000 + 3000) * 1024);
  });

  test("no address space (a kernel thread, a zombie) is refused, not zero", () => {
    expect(
      procRusageFromProcfs({ status: "Name:\tkthreadd\n", stat: STAT }).kind,
    ).toBe("refused");
  });

  test("an address space gone between the reads is refused", () => {
    expect(
      procRusageFromProcfs({ smapsRollup: "", status: STATUS, stat: STAT })
        .kind,
    ).toBe("refused");
  });

  test("a kernel whose rollup does not split Pss answers unsupported", () => {
    expect(
      procRusageFromProcfs({
        smapsRollup: SMAPS_ROLLUP.replace(/^Pss_Anon:.*\n/m, ""),
        status: STATUS,
        stat: STAT,
      }).kind,
    ).toBe("unsupported");
  });
});

test("parseProcStat reads after the last ')'", () => {
  expect(parseProcStat(STAT)).toEqual({
    utime: 250,
    stime: 30,
    cutime: 7,
    cstime: 3,
    starttime: 5000,
  });
});

describe.if(process.platform === "linux")("reading this process", () => {
  test("counted and proportional", async () => {
    for (const r of [
      readLinuxProcRusageSync(process.pid),
      await readLinuxProcRusage(process.pid),
    ]) {
      if (r.kind !== "read") throw new Error(r.kind);
      expect(r.memory.physFootprintBytes).toBeGreaterThan(0);
      expect(r.memory.peakPhysFootprintBytes).toBeGreaterThanOrEqual(
        r.memory.physFootprintBytes,
      );
    }
  });

  test("a pid that is not running is refused, not zero", async () => {
    expect(readLinuxProcRusageSync(99_999_999).kind).toBe("refused");
    expect((await readLinuxProcRusage(99_999_999)).kind).toBe("refused");
  });
});
