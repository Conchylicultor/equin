// Pure Linux `/proc/meminfo` and `/proc/vmstat` parsing: the Linux half of the
// host memory reading (`host-memory.ts`), beside macOS's `vm_stat`
// (`vm-stat.ts`). No imports, so every runtime can.

/** `/proc/meminfo`, every counter in bytes (the file states them in kB). */
export type Meminfo = Record<string, number>;

export function parseMeminfo(text: string): Meminfo {
  const map: Meminfo = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([\w()]+):\s+(\d+)(\s+kB)?\s*$/);
    if (m) map[m[1]!] = Number(m[2]) * (m[3] ? 1024 : 1);
  }
  return map;
}

/** `/proc/vmstat`: one `name value` counter per line (pages or events). */
export function parseProcVmstat(text: string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+)\s+(\d+)\s*$/);
    if (m) map[m[1]!] = Number(m[2]);
  }
  return map;
}

function sum(
  map: Record<string, number>,
  required: string[],
  optional: string[],
  source: string,
): number {
  let total = 0;
  for (const key of required) {
    const n = map[key];
    if (n === undefined) throw new Error(`${source} has no "${key}" line`);
    total += n;
  }
  for (const key of optional) total += map[key] ?? 0;
  return total;
}

/**
 * Memory the system can hand out without swapping: the kernel's own estimate,
 * `MemAvailable` (free + the reclaimable part of the page cache and slab).
 * Throws when the line is missing — a kernel too old to state it must not read
 * as "no memory left".
 */
export function meminfoAvailableBytes(mi: Meminfo): number {
  return sum(mi, ["MemAvailable"], [], "/proc/meminfo");
}

/**
 * Kernel memory no process carries — Linux's counterpart of macOS's wired
 * pages — as the residual: RAM that is neither free, on a page LRU (file or
 * anonymous, active or inactive, or unevictable) nor reclaimable slab. That is
 * unreclaimable slab, kernel stacks, page tables, vmalloc, per-cpu areas,
 * reserved huge pages, the zswap / zram compressed pools and driver memory —
 * everything macOS counts as wired — without having to list each (a list
 * misses whatever it does not name, and what it misses reads as room for the
 * fleet). Floored at 0: the counters are not read atomically.
 */
export function meminfoKernelBytes(mi: Meminfo): number {
  const total = sum(mi, ["MemTotal"], [], "/proc/meminfo");
  const accounted = sum(
    mi,
    [
      "MemFree",
      "Active(file)",
      "Inactive(file)",
      "Active(anon)",
      "Inactive(anon)",
      "Unevictable",
      "SReclaimable",
    ],
    [],
    "/proc/meminfo",
  );
  return Math.max(0, total - accounted);
}

/**
 * The RAM processes hold: anonymous pages (`AnonPages`) and shared memory
 * (`Shmem` — Postgres's shared buffers, tmpfs; not reclaimable without swap).
 * The file cache is reclaimable, so not counted; compressed pages (zswap,
 * zram) are in the kernel residual (`meminfoKernelBytes`), never here too.
 */
export function meminfoProcessBytes(mi: Meminfo): number {
  return sum(mi, ["AnonPages", "Shmem"], [], "/proc/meminfo");
}
