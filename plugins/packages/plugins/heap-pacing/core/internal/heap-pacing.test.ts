import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  CHECK_PROCESS_RAM_BYTES,
  HEAP_PACED_ENV,
  HEAVY_PROCESS_RAM_BYTES,
  JSC_RAM_SIZE_ENV,
  pacedHeapEnv,
  parentPacedHeapEnv,
} from "./heap-pacing";

describe("pacedHeapEnv", () => {
  test("sets the JSC RAM size, marked as this repo's, and keeps every other variable", () => {
    const env = { PATH: "/bin", HOME: "/h" };
    expect(pacedHeapEnv(env)).toEqual({
      PATH: "/bin",
      HOME: "/h",
      [JSC_RAM_SIZE_ENV]: String(HEAVY_PROCESS_RAM_BYTES),
      [HEAP_PACED_ENV]: "1",
    });
  });

  test("a value a person set wins", () => {
    expect(pacedHeapEnv({ [JSC_RAM_SIZE_ENV]: "3000000000" }, 1.5e9)).toEqual({
      [JSC_RAM_SIZE_ENV]: "3000000000",
    });
  });

  test("a pace inherited from a paced parent is replaced by the child's own", () => {
    // A check pass (paced at CHECK_PROCESS_RAM_BYTES) starting its type-check
    // worker at the worker's profile.
    const parent = pacedHeapEnv({ PATH: "/bin" }, CHECK_PROCESS_RAM_BYTES);
    expect(pacedHeapEnv(parent, 1.5e9)).toEqual({
      PATH: "/bin",
      [JSC_RAM_SIZE_ENV]: "1500000000",
      [HEAP_PACED_ENV]: "1",
    });
  });

  test("a child doing its parent's own work runs at the parent's pace", () => {
    const worker = pacedHeapEnv({ PATH: "/bin" }, 1.5e9);
    expect(parentPacedHeapEnv(worker)).toEqual(worker);
    expect(parentPacedHeapEnv({ PATH: "/bin" })).toEqual(
      pacedHeapEnv({ PATH: "/bin" }),
    );
  });

  test("paces against the share a caller names", () => {
    expect(pacedHeapEnv({ PATH: "/bin" }, 1.5e9)).toEqual({
      PATH: "/bin",
      [JSC_RAM_SIZE_ENV]: "1500000000",
      [HEAP_PACED_ENV]: "1",
    });
  });

  test("the ./equin shim paces a direct check pass as its build child is", () => {
    // JSC reads the pace at VM start, so a direct `./equin check` gets it from
    // the shell script that execs bun — which cannot import the constant.
    const shim = readFileSync(join(REPO_ROOT, "equin"), "utf8");
    expect(shim).toContain(
      `export ${JSC_RAM_SIZE_ENV}=${CHECK_PROCESS_RAM_BYTES} ${HEAP_PACED_ENV}=1`,
    );
  });

  test("a non-positive share is refused, never paced to nothing", () => {
    expect(() => pacedHeapEnv({}, 0)).toThrow(/must be positive/);
    expect(() => pacedHeapEnv({}, Number.NaN)).toThrow(/must be positive/);
  });

  test("never mutates its input", () => {
    const env: Record<string, string> = { PATH: "/bin" };
    pacedHeapEnv(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  test.if(process.platform === "darwin")(
    "bun reads it: a paced child collects a growing heap sooner",
    async () => {
      // Hold ~1 GB live (doubles, 8 bytes each) and churn ~8 GB of garbage
      // past it. Told it has 64 GB, JSC lets the heap reach ~3 GB; paced at
      // 1 GB it collects near the live size (measured 2.96 vs 1.51 GB). A bun
      // that stopped reading the variable would peak the same twice.
      const script = `
      const live = [];
      for (let i = 0; i < 1000; i++) live.push(new Array(125_000).fill(i + 0.5));
      for (let i = 0; i < 8000; i++) new Array(125_000).fill(i + 0.5);
      // Read last, so the live set stays live to the end.
      if (live.length !== 1000) throw new Error("live set lost");
    `;
      // The child's peak physical footprint: what its heap made it hold.
      const peak = async (ram: string): Promise<number> => {
        const r = await spawnCaptured([process.execPath, "-e", script], {
          env: { ...process.env, [JSC_RAM_SIZE_ENV]: ram },
          peakFootprint: "report",
          timeoutMs: 60_000,
        });
        expect(r.exitCode).toBe(0);
        const p = r.resourceUsage.peakFootprint;
        if (p.kind !== "measured") throw new Error(JSON.stringify(p));
        return p.bytes;
      };
      const wide = await peak(String(64e9));
      const paced = await peak(String(1e9));
      expect(paced).toBeLessThan(wide * 0.75);
    },
    60_000,
  );
});
