import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readProcRusageSync } from "./proc-rusage";

describe.if(process.platform === "darwin")("readProcRusageSync", () => {
  test("reads this process: a footprint, and CPU time that grows", () => {
    const a = readProcRusageSync(process.pid);
    if (a.kind !== "read") throw new Error(a.kind);
    expect(a.memory.physFootprintBytes).toBeGreaterThan(0);
    let x = 0;
    for (let i = 0; i < 5_000_000; i++) x += i;
    expect(x).toBeGreaterThan(0);
    const b = readProcRusageSync(process.pid);
    if (b.kind !== "read") throw new Error(b.kind);
    expect(b.cpu.ownNs).toBeGreaterThan(a.cpu.ownNs);
  });

  test("a reaped child's CPU lands in its parent's reaped-children time", () => {
    const before = readProcRusageSync(process.pid);
    if (before.kind !== "read") throw new Error(before.kind);
    spawnSync("sh", ["-c", "i=0; while [ $i -lt 50000 ]; do i=$((i+1)); done"]);
    const after = readProcRusageSync(process.pid);
    if (after.kind !== "read") throw new Error(after.kind);
    expect(
      after.cpu.reapedChildrenNs - before.cpu.reapedChildrenNs,
    ).toBeGreaterThan(10_000_000);
  });

  test("the lifetime peak keeps what the footprint gave back", () => {
    let block: Uint8Array | null = new Uint8Array(300e6);
    block.fill(1);
    const during = readProcRusageSync(process.pid);
    block = null;
    Bun.gc(true);
    const after = readProcRusageSync(process.pid);
    if (during.kind !== "read" || after.kind !== "read") throw new Error();
    expect(during.memory.peakPhysFootprintBytes).toBeGreaterThanOrEqual(
      during.memory.physFootprintBytes,
    );
    expect(after.memory.peakPhysFootprintBytes).toBeGreaterThanOrEqual(
      during.memory.physFootprintBytes,
    );
  });

  test("a pid that is not running is refused, not zero", () => {
    expect(readProcRusageSync(99_999_999).kind).toBe("refused");
  });
});
