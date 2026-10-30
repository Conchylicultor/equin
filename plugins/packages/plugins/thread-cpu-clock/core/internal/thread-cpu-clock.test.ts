import { describe, expect, test } from "bun:test";
import { readThreadCpu } from "./thread-cpu-clock";

const supported = process.platform === "darwin" || process.platform === "linux";

function read(): number {
  const r = readThreadCpu();
  if (!r.supported) throw new Error("expected support on this platform");
  return r.ms;
}

describe.if(supported)("readThreadCpu", () => {
  test("advances by the time this thread spends working", () => {
    const before = read();
    const until = performance.now() + 200;
    while (performance.now() < until) {
      // busy
    }
    expect(read() - before).toBeGreaterThanOrEqual(150);
  });

  test("does not advance while this thread waits", async () => {
    const before = read();
    await Bun.sleep(200);
    expect(read() - before).toBeLessThan(50);
  });
});

describe.if(!supported)("readThreadCpu (elsewhere)", () => {
  test("says it cannot tell", () => {
    expect(readThreadCpu()).toEqual({ supported: false });
  });
});
