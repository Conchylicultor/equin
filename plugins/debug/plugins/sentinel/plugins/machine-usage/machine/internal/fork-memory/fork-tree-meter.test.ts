import { describe, expect, it } from "bun:test";
import {
  createForkTreeMeter,
  type ProcessStamp,
  type Region,
} from "./fork-tree-meter";

const PAGE = 16_384;
const RW = 3;
const R = 1;

function region(start: number, size: number, r: Partial<Region>): Region {
  return {
    start,
    end: start + size,
    protection: RW,
    inheritance: 1, // VM_INHERIT_COPY
    shareMode: 1, // SM_COW
    residentPages: 0,
    swappedPages: 0,
    privateResidentPages: 0,
    objectId: start,
    ...r,
  };
}

/** A fake kernel: each pid's regions, sorted, and a count of the reads. */
function fakeKernel(maps: Record<number, Region[]>) {
  const reads: [number, number][] = [];
  const stamps = new Map<number, ProcessStamp>(
    Object.keys(maps).map((pid) => [
      Number(pid),
      { startedAt: 1, footprintBytes: 100 },
    ]),
  );
  const meter = createForkTreeMeter({
    readRegion: (pid, address) => {
      reads.push([pid, address]);
      return maps[pid]?.find((r) => r.end > address) ?? null;
    },
    readStamp: (pid) => (maps[pid] ? (stamps.get(pid) ?? null) : null),
    pageBytes: PAGE,
  });
  return { meter, reads, stamps };
}

// The postmaster: its text (read-only), the shared segment (MAP_SHARED),
// a malloc region its children share copy-on-write, a reservation.
const TEXT = region(0, 100, { protection: R, privateResidentPages: 0 });
const SEGMENT = region(100, 1000, {
  inheritance: 0,
  shareMode: 4,
  residentPages: 50,
  swappedPages: 10,
  objectId: 7,
});
const PM_HEAP = region(1100, 100, {
  shareMode: 5,
  residentPages: 4,
  objectId: 9,
});
const RESERVED = region(1200, 100, { protection: 0, shareMode: 3 });

describe("createForkTreeMeter", () => {
  it("charges each child its private pages and the root the shared ones once", () => {
    const child = (priv: number) => [
      TEXT,
      SEGMENT,
      region(1100, 100, { privateResidentPages: priv, swappedPages: 1 }),
      // Mapped into the reservation since the fork: walked, not skipped.
      region(1200, 100, { privateResidentPages: 2 }),
    ];
    const { meter } = fakeKernel({
      10: [TEXT, SEGMENT, PM_HEAP, RESERVED],
      11: child(5),
      12: child(3),
    });
    const out = meter.measure([{ root: 10, members: [11, 12] }]);
    expect(out.get(11)).toBe((5 + 1 + 2) * PAGE);
    expect(out.get(12)).toBe((3 + 1 + 2) * PAGE);
    // Segment (resident + compressed) and the copy-on-write heap, once.
    expect(out.get(10)).toBe((60 + 4) * PAGE);
  });

  it("steps over the root's read-only and shared ranges in a child", () => {
    const { meter, reads } = fakeKernel({
      10: [TEXT, SEGMENT, PM_HEAP],
      11: [TEXT, SEGMENT, region(1100, 100, { privateResidentPages: 1 })],
    });
    meter.measure([{ root: 10, members: [11] }]);
    const childReads = reads.filter(([pid]) => pid === 11).map(([, a]) => a);
    expect(childReads).not.toContain(0);
    expect(childReads).not.toContain(100);
  });

  it("counts a segment only a child maps once across children", () => {
    const dsm = region(2000, 100, {
      shareMode: 5,
      residentPages: 8,
      objectId: 42,
    });
    const { meter } = fakeKernel({ 10: [TEXT], 11: [dsm], 12: [dsm] });
    const out = meter.measure([{ root: 10, members: [11, 12] }]);
    expect(out.get(11)).toBe(0);
    expect(out.get(10)).toBe(8 * PAGE);
  });

  it("walks a child again only when its footprint or start moved", () => {
    const heap = region(1100, 100, { privateResidentPages: 1 });
    const { meter, reads, stamps } = fakeKernel({ 10: [TEXT], 11: [heap] });
    const tree = [{ root: 10, members: [11] }];
    meter.measure(tree);
    // A child walk starts past the root's read-only text (0–100).
    const walks = () =>
      reads.filter(([pid, a]) => pid === 11 && a === 100).length;
    expect(walks()).toBe(1);
    meter.measure(tree);
    expect(walks()).toBe(1);
    stamps.set(11, { startedAt: 1, footprintBytes: 200 });
    meter.measure(tree);
    expect(walks()).toBe(2);
    stamps.set(11, { startedAt: 2, footprintBytes: 200 });
    meter.measure(tree);
    expect(walks()).toBe(3);
  });

  it("leaves out a process gone before it was read", () => {
    const { meter } = fakeKernel({ 10: [TEXT] });
    const out = meter.measure([{ root: 10, members: [99] }]);
    expect(out.has(99)).toBe(false);
    expect(out.get(10)).toBe(0);
  });
});
