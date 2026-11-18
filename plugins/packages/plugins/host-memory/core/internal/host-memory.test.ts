import { describe, expect, test } from "bun:test";
import { hostMemoryFromProc, hostMemoryFromVmStat } from "./host-memory";
import { parseMeminfo, parseProcVmstat } from "./proc-meminfo";
import { parseVmStat } from "./vm-stat";

// Trimmed real `/proc/meminfo` (Ubuntu 24.04, kernel 6.8, arm64).
const MEMINFO = `MemTotal:        8131700 kB
MemFree:         5212344 kB
Active(anon):     500000 kB
Inactive(anon):   389860 kB
Active(file):     900000 kB
Inactive(file):   938072 kB
Unevictable:        1000 kB
MemAvailable:    7012988 kB
Buffers:           61232 kB
Cached:          1838072 kB
SwapCached:            0 kB
AnonPages:        791204 kB
Mapped:           380016 kB
Shmem:             98656 kB
KReclaimable:     105880 kB
Slab:             221860 kB
SReclaimable:     105880 kB
SUnreclaim:       115980 kB
KernelStack:       10336 kB
PageTables:        14528 kB
SecPageTables:         0 kB
Percpu:             3456 kB
HugePages_Total:       0
Hugepagesize:       2048 kB
`;

const PROC_VMSTAT = `nr_free_pages 1303086
pgpgin 1180224
pswpin 12
pswpout 34
zswpin 5
zswpout 7
`;

describe("parseMeminfo", () => {
  test("reads kB counters as bytes, unit-less counters as they are", () => {
    const mi = parseMeminfo(MEMINFO);
    expect(mi["MemAvailable"]).toBe(7012988 * 1024);
    expect(mi["HugePages_Total"]).toBe(0);
  });
});

describe("hostMemoryFromProc", () => {
  const memory = hostMemoryFromProc(
    parseMeminfo(MEMINFO),
    parseProcVmstat(PROC_VMSTAT),
  );

  test("available is MemAvailable", () => {
    expect(memory.availableBytes).toBe(7012988 * 1024);
  });

  test("kernel memory is what is neither free, on an LRU nor reclaimable slab", () => {
    expect(memory.kernelBytes).toBe(
      (8131700 -
        5212344 -
        (500000 + 389860 + 900000 + 938072 + 1000) -
        105880) *
        1024,
    );
  });

  test("counters are null where /proc/vmstat does not state swap", () => {
    expect(
      hostMemoryFromProc(parseMeminfo(MEMINFO), parseProcVmstat("pgpgin 1\n"))
        .counters,
    ).toBeNull();
  });

  test("process memory is anonymous and shared pages (no zswap line: none)", () => {
    expect(memory.processBytes).toBe((791204 + 98656) * 1024);
    expect(memory.compressorBytes).toBe(0);
  });

  test("counters are pswpin/pswpout and zswap's", () => {
    expect(memory.counters).toEqual({
      swapIns: 12,
      swapOuts: 34,
      compressions: 7,
      decompressions: 5,
    });
  });

  test("throws when a required counter is missing, never reads it as 0", () => {
    expect(() =>
      hostMemoryFromProc(parseMeminfo("MemTotal: 1 kB\n"), {}),
    ).toThrow(/MemAvailable/);
  });
});

describe("hostMemoryFromVmStat", () => {
  test("derives every field from one vm_stat reading", () => {
    const vm =
      parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10.
Pages inactive:                           20.
Pages speculative:                        30.
Pages wired down:                         40.
Pages occupied by compressor:             50.
Anonymous pages:                          60.
Swapins:                                   1.
Swapouts:                                  2.
Compressions:                              3.
Decompressions:                            4.
`);
    expect(hostMemoryFromVmStat(vm)).toEqual({
      platform: "darwin",
      availableBytes: 60 * 16384,
      kernelBytes: 40 * 16384,
      processBytes: 110 * 16384,
      compressorBytes: 50 * 16384,
      counters: { swapIns: 1, swapOuts: 2, compressions: 3, decompressions: 4 },
    });
  });
});
