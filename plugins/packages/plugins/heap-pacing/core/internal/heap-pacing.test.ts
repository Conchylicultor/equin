import { describe, expect, test } from "bun:test";
import {
  HEAVY_PROCESS_RAM_BYTES,
  JSC_RAM_SIZE_ENV,
  pacedHeapEnv,
} from "./heap-pacing";

describe("pacedHeapEnv", () => {
  test("sets the JSC RAM size and keeps every other variable", () => {
    const env = { PATH: "/bin", HOME: "/h" };
    expect(pacedHeapEnv(env)).toEqual({
      PATH: "/bin",
      HOME: "/h",
      [JSC_RAM_SIZE_ENV]: String(HEAVY_PROCESS_RAM_BYTES),
    });
  });

  test("a value already set wins", () => {
    expect(pacedHeapEnv({ [JSC_RAM_SIZE_ENV]: "2000000000" })).toEqual({
      [JSC_RAM_SIZE_ENV]: "2000000000",
    });
  });

  test("never mutates its input", () => {
    const env: Record<string, string> = { PATH: "/bin" };
    pacedHeapEnv(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("bun reads it: a paced child collects a growing heap sooner", async () => {
    // Hold ~1 GB live (doubles, 8 bytes each) and churn ~8 GB of garbage
    // past it. Told it has 64 GB, JSC lets the heap reach ~3 GB; paced at
    // 1 GB it collects near the live size (measured 2.96 vs 1.51 GB). A bun
    // that stopped reading the variable would peak the same twice.
    const script = `
      const live = [];
      for (let i = 0; i < 1000; i++) live.push(new Array(125_000).fill(i + 0.5));
      for (let i = 0; i < 8000; i++) new Array(125_000).fill(i + 0.5);
      console.log(process.resourceUsage().maxRSS);
    `;
    const peak = async (ram: string): Promise<number> => {
      const p = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, [JSC_RAM_SIZE_ENV]: ram },
        stdout: "pipe",
      });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return Number(out.trim());
    };
    const wide = await peak(String(64e9));
    const paced = await peak(String(1e9));
    expect(paced).toBeLessThan(wide * 0.75);
  }, 60_000);
});
