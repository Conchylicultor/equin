import { describe, expect, test } from "bun:test";
import { oomKillCountFromProcVmstat, readOomKillCount } from "./oom-kills";

// Trimmed real `/proc/vmstat` (Ubuntu 24.04, kernel 6.8): `oom_kill` sits
// among the event counters.
const PROC_VMSTAT = `nr_free_pages 1303086
pswpin 12
pswpout 34
oom_kill 3
compact_stall 0
`;

describe("oomKillCountFromProcVmstat", () => {
  test("reads the oom_kill line", () => {
    expect(oomKillCountFromProcVmstat(PROC_VMSTAT)).toEqual({
      kind: "read",
      count: 3,
    });
  });

  test("a zero count is a reading of zero", () => {
    expect(oomKillCountFromProcVmstat("oom_kill 0\n")).toEqual({
      kind: "read",
      count: 0,
    });
  });

  test("a kernel without the line is unstated, never 0", () => {
    expect(oomKillCountFromProcVmstat("pswpin 12\n")).toEqual({
      kind: "unstated",
    });
  });
});

describe("readOomKillCount", () => {
  test("reads /proc/vmstat on Linux", async () => {
    const paths: string[] = [];
    const read = await readOomKillCount("linux", async (path) => {
      paths.push(path);
      return PROC_VMSTAT;
    });
    expect(paths).toEqual(["/proc/vmstat"]);
    expect(read).toEqual({ kind: "read", count: 3 });
  });

  test("macOS has no counter: unsupported, and reads nothing", async () => {
    let reads = 0;
    const read = await readOomKillCount("darwin", async () => {
      reads++;
      return "";
    });
    expect(read).toEqual({ kind: "unsupported", platform: "darwin" });
    expect(reads).toBe(0);
  });

  test("a failed read is unreadable, never 0", async () => {
    const read = await readOomKillCount("linux", async () => {
      throw new Error("EACCES: /proc/vmstat");
    });
    expect(read).toEqual({
      kind: "unreadable",
      error: "EACCES: /proc/vmstat",
    });
  });
});
