// Pure `vm_stat` output parsing — kept free of log-channel/server imports so
// the parser stays testable with a plain co-located bun:test.

export interface VmStat {
  pageSize: number;
  map: Record<string, number>;
}

export function parseVmStat(text: string): VmStat {
  const pageSizeMatch = text.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384;
  const map: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z][\w .()/-]+?):\s+(\d+)\.?\s*$/);
    if (m) map[m[1]!.trim()] = Number(m[2]);
  }
  return { pageSize, map };
}

/**
 * Memory the system can hand out without swapping, in bytes: free + speculative
 * + inactive pages — the estimate psutil's `available` uses on macOS. `Pages
 * free` alone (what `os.freemem()` reads) stays near zero on a healthy Mac,
 * which keeps every page it can as cache. `Pages purgeable` is not added: those
 * pages are already counted inside active/inactive. Throws when a counter is
 * missing — a renamed vm_stat line must not read as "no memory left".
 */
export function availableMemBytes(vm: VmStat): number {
  const pages = ["Pages free", "Pages speculative", "Pages inactive"].map(
    (key) => {
      const n = vm.map[key];
      if (n === undefined) throw new Error(`vm_stat has no "${key}" line`);
      return n;
    },
  );
  return pages.reduce((a, b) => a + b, 0) * vm.pageSize;
}
