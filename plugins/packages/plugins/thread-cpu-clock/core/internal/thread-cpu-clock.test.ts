import { describe, expect, test } from "bun:test";
import { readThreadCpu, threadCpuHandle } from "./thread-cpu-clock";

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

describe.if(supported)("readThreadCpuOf", () => {
  test("reads the thread that took the handle, from another thread", async () => {
    const handle = threadCpuHandle();
    // A worker reads this (main) thread's clock while it spins, then while it
    // waits: the spin shows, the wait does not.
    const worker = new Worker(
      new URL("./__tests__/read-other-thread.worker.ts", import.meta.url),
    );
    const ask = (): Promise<number> =>
      new Promise((resolve) => {
        worker.onmessage = (
          e: MessageEvent<{ supported: boolean; ms: number }>,
        ) => resolve(e.data.ms);
        worker.postMessage(handle);
      });
    try {
      const before = await ask();
      const until = performance.now() + 200;
      while (performance.now() < until) {
        // busy
      }
      const afterSpin = await ask();
      expect(afterSpin - before).toBeGreaterThanOrEqual(150);
      await Bun.sleep(200);
      const afterWait = await ask();
      expect(afterWait - afterSpin).toBeLessThan(50);
    } finally {
      worker.terminate();
    }
  });
});
