import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import { readBackendP99Rollup, readHostCompressor } from "./sample";

// The gatherers resolve worktree dirs through worktreesDir()
// (the bun-test preload evaluates infra/paths before any test body runs, so an
// env redirect cannot take effect in-process). So these tests plant throwaway,
// uniquely-named fake worktrees inside the REAL worktrees dir and assert only
// on those names — live worktrees on the host are never touched and never
// asserted on. Cleaned up in afterAll.

const runId = `sentinel-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FRESH_WT = `${runId}-fresh`;
const STALE_WT = `${runId}-stale`;
const HOST_WT = `${runId}-host`;
const created: string[] = [];

function envelope(line: string): string {
  return JSON.stringify({ t: Date.now(), stream: "stdout", line }) + "\n";
}

function plantChannelLine(
  worktree: string,
  channel: string,
  line: string,
): string {
  const dir = join(worktreesDir(), worktree, "logs");
  mkdirSync(dir, { recursive: true });
  created.push(join(worktreesDir(), worktree));
  const file = join(dir, `${channel}.jsonl`);
  writeFileSync(file, envelope(line));
  return file;
}

function healthSample(p99: number): string {
  return JSON.stringify({
    sampledAt: Date.now(),
    worktree: "x",
    eventLoopP50Ms: 1,
    eventLoopP99Ms: p99,
    eventLoopMaxMs: p99 * 2,
    physFootprintMb: 100,
    heapUsedMb: 50,
    heapTotalMb: 80,
    heapGrowthMb: 0,
    gcPreciseCount: 0,
    gcPreciseTotalMs: 0,
    heavyReadDepth: 0,
  });
}

function hostSample(
  overrides: Record<string, number | undefined> = {},
): string {
  return JSON.stringify({
    sampledAt: Date.now(),
    freeMemMb: 512,
    totalMemMb: 65_536,
    usedMemMb: 65_024,
    loadAvg1: 3,
    loadAvg5: 3,
    loadAvg15: 3,
    swapInPagesPerSec: 0,
    swapOutPagesPerSec: 0,
    compressionsPerSec: 1_000,
    decompressionsPerSec: 240_000,
    compressorMb: 30_000,
    ...overrides,
  });
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("readBackendP99Rollup", () => {
  test("fresh health.jsonl tail lands in the rollup; stale mtime drops out", async () => {
    plantChannelLine(FRESH_WT, "health", healthSample(1234));
    const staleFile = plantChannelLine(STALE_WT, "health", healthSample(999));
    // Stale: a backend whose health file went quiet is a stopped backend.
    const old = new Date(Date.now() - 120_000);
    utimesSync(staleFile, old, old);

    const rollup = await readBackendP99Rollup();
    expect(rollup[FRESH_WT]).toBe(1234);
    expect(rollup[STALE_WT]).toBeUndefined();
  });
});

describe("readHostCompressor", () => {
  test("fresh line yields the compressor fields", async () => {
    plantChannelLine(HOST_WT, "health-host", hostSample());
    expect(await readHostCompressor(HOST_WT)).toEqual({
      decompressionsPerSec: 240_000,
      compressorMb: 30_000,
      freeMemMb: 512,
    });
  });

  test("stale line (host sampler dead > 30s) reads null", async () => {
    plantChannelLine(
      HOST_WT,
      "health-host",
      hostSample({ sampledAt: Date.now() - 60_000 }),
    );
    expect(await readHostCompressor(HOST_WT)).toEqual({
      decompressionsPerSec: null,
      compressorMb: null,
      freeMemMb: null,
    });
  });

  test("wallJumpMs-stamped line (machine sleep) reads null — no measurement this window", async () => {
    plantChannelLine(
      HOST_WT,
      "health-host",
      hostSample({ wallJumpMs: 900_000 }),
    );
    expect(await readHostCompressor(HOST_WT)).toEqual({
      decompressionsPerSec: null,
      compressorMb: null,
      freeMemMb: null,
    });
  });

  test("missing file / pre-cutover line read null", async () => {
    expect(await readHostCompressor(`${runId}-never-existed`)).toEqual({
      decompressionsPerSec: null,
      compressorMb: null,
      freeMemMb: null,
    });
    // Pre-cutover: compressor fields absent — decompressions null, not 0.
    plantChannelLine(
      HOST_WT,
      "health-host",
      hostSample({
        compressionsPerSec: undefined,
        decompressionsPerSec: undefined,
        compressorMb: undefined,
      }),
    );
    expect(await readHostCompressor(HOST_WT)).toEqual({
      decompressionsPerSec: null,
      compressorMb: null,
      freeMemMb: 512,
    });
  });
});
