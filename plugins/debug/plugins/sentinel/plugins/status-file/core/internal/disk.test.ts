import { describe, expect, test } from "bun:test";
import { bytesText, diskAlarmOf } from "./disk";

const GIB = 1024 ** 3;
const TOTAL = 926 * GIB;

function at(freeGib: number, fillGibPerMin: number | null = 0) {
  return diskAlarmOf({
    totalBytes: TOTAL,
    freeBytes: freeGib * GIB,
    fillBytesPerSec: fillGibPerMin === null ? null : (fillGibPerMin * GIB) / 60,
  });
}

describe("diskAlarmOf", () => {
  test("ok with room and a steady disk", () => {
    expect(at(600)).toBe("ok");
    expect(at(600, null)).toBe("ok");
    // A build's writes: well under a GiB a minute.
    expect(at(600, 0.3)).toBe("ok");
  });

  test("low under 50 GiB, full under 10 GiB", () => {
    expect(at(49)).toBe("low");
    expect(at(9)).toBe("full");
    expect(at(9, 5)).toBe("full");
  });

  test("filling at a GiB a minute, full-soon when that empties it within the hour", () => {
    // The 2026-10-15 runaway `cat`: far past a GiB a minute, 600 GiB free.
    expect(at(600, 1)).toBe("filling");
    expect(at(600, 20)).toBe("full-soon");
    expect(at(40, 1)).toBe("full-soon");
  });
});

describe("bytesText", () => {
  test("rounds like the Finder", () => {
    expect(bytesText(606 * GIB)).toBe("606 GB");
    expect(bytesText(1.44 * GIB)).toBe("1.4 GB");
    expect(bytesText(512 * 1024 ** 2)).toBe("512 MB");
  });
});
