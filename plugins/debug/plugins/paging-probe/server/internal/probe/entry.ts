// The standalone twin-probe entry — spawned as its own child process (NOT a
// Worker: a worker would share main's address space and phys_footprint ledger,
// so it could never be an independent paging victim). One process per variant;
// see server/internal/probe-host.ts for the supervisor.
//
// LEAN CLOSURE IS LOAD-BEARING. This file imports ONLY runtime builtins
// (node:fs, node:perf_hooks, node:crypto, bun:ffi) plus the zero-import
// core/probe-logic FILE (deliberately not the core barrel, which pulls the
// config_v2 graph). It must NOT import @plugins/* or the plugin runtime, and
// the two native snippets below are COPIED (not imported) from their source
// plugins for the same reason: importing server-core / spawn-priority would
// pull the whole plugin graph into this probe's own heap and destroy the very
// measurement it exists to take (a fair, minimal-footprint twin of main).
//
// Run: bun server/internal/probe/entry.ts <variant> --fat-size-mb N \
//        --touch-slice-mb N --gc-each-minute 0|1 --boost-qos 0|1 --out <jsonl-path>

import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { randomFillSync } from "node:crypto";
import { dlopen, ptr } from "bun:ffi";
import {
  lateByMs,
  parseProbeArgs,
  pickTouchSlice,
  TICK_MS,
  type ProbeSample,
} from "../../../core/probe-logic";

// ---------------------------------------------------------------------------
// proc_pid_rusage FFI — a DELIBERATE COPY of
// plugins/framework/plugins/server-core/bin/phys-footprint.ts, reading BOTH
// ri_phys_footprint (offset 72) and ri_resident_size (offset 64) from the same
// RUSAGE_INFO_V0 buffer in one syscall. phys_footprint counts compressed private
// pages; resident is what is physically in RAM right now — the difference is the
// per-probe "squeezed out" signal. See phys-footprint.ts for the struct layout
// and the rss-over-counts-~6x rationale. Copied, not imported, per the header.
// ---------------------------------------------------------------------------
const RUSAGE_INFO_V0 = 0;
const RESIDENT_SIZE_OFFSET = 64;
const PHYS_FOOTPRINT_OFFSET = 72;
const RUSAGE_BUF_BYTES = 128; // >= sizeof(rusage_info_v0)=96, padded

let procPidRusage: ((pid: number, flavor: number, buf: unknown) => number) | null = null;
function bindProcPidRusage(): (pid: number, flavor: number, buf: unknown) => number {
  if (!procPidRusage) {
    const { symbols } = dlopen("libc.dylib", {
      proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
    });
    procPidRusage = symbols.proc_pid_rusage as (
      pid: number,
      flavor: number,
      buf: unknown,
    ) => number;
  }
  return procPidRusage;
}

interface ProcMemory {
  physFootprintMb: number | null;
  residentMb: number | null;
}

let ffiWarned = false;

// Reads both memory offsets, or null-in-place on any failure — the probe must
// keep sampling lag even if the FFI breaks on a future OS (a missing memory
// column must never take down the headline lateByMs series). Nulls are a real
// answer the schema models; the first failure logs to stderr so the degradation
// is visible rather than silent.
function readProcMemory(): ProcMemory {
  if (process.platform !== "darwin") return { physFootprintMb: null, residentMb: null };
  try {
    const buf = new Uint8Array(RUSAGE_BUF_BYTES);
    const rc = bindProcPidRusage()(process.pid, RUSAGE_INFO_V0, ptr(buf));
    if (rc !== 0) return { physFootprintMb: null, residentMb: null };
    const view = new DataView(buf.buffer);
    return {
      physFootprintMb: Number(view.getBigUint64(PHYS_FOOTPRINT_OFFSET, true)) / 1_048_576,
      residentMb: Number(view.getBigUint64(RESIDENT_SIZE_OFFSET, true)) / 1_048_576,
    };
  } catch (err) {
    if (!ffiWarned) {
      ffiWarned = true;
      process.stderr.write(
        `[paging-probe] proc_pid_rusage FFI failed, memory columns null: ${String(err)}\n`,
      );
    }
    return { physFootprintMb: null, residentMb: null };
  }
}

// ---------------------------------------------------------------------------
// pthread QoS FFI — a DELIBERATE COPY of boostInteractiveQos() from
// plugins/packages/plugins/spawn-priority/server/internal/spawn-priority.ts.
// Copied, not imported, per the header. The parent cannot set a child's QoS, so
// when the supervisor passes --boost-qos 1 the probe raises ITS OWN calling
// thread to user-interactive QoS — the boosted second axis alongside the
// default-QoS fair twins.
// ---------------------------------------------------------------------------
const QOS_CLASS_USER_INTERACTIVE = 0x21;
function boostQos(): void {
  if (process.platform !== "darwin") return;
  try {
    const { symbols } = dlopen("libSystem.dylib", {
      pthread_set_qos_class_self_np: { args: ["u32", "i32"], returns: "i32" },
    });
    const rc = symbols.pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
    if (rc !== 0) process.stderr.write(`[paging-probe] QoS boost failed (rc=${String(rc)})\n`);
  } catch (err) {
    process.stderr.write(`[paging-probe] QoS boost unavailable: ${String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Heap shaping
// ---------------------------------------------------------------------------
const MB = 1_048_576;
const CHUNK_BYTES = MB; // 1 MB chunks
const ENTROPY_BLOCK_BYTES = 4_096; // 4 KB random block, repeated 256x to fill a chunk
const PAGE_BYTES = 16_384; // touch one byte per 16 KB (Apple Silicon page size)

// Retained for the whole process lifetime so the pages stay allocated and go
// cold — the module-level array is the anchor the GC cannot reclaim.
const heap: Uint8Array[] = [];

// Allocate `sizeMb` of 1 MB chunks with MIXED entropy: each chunk is a single
// 4 KB cryptographically-random block repeated to fill 1 MB. Fully-random pages
// are INCOMPRESSIBLE, so macOS would swap them rather than compress — which
// weakens the compressor-victim signal under test. A repeated random block is
// non-trivial (not zero pages the kernel dedups) yet compresses ~4:1-ish, so the
// pages land in the compressor like a real cold heap. Filling via .set() already
// faults every page resident; the explicit page walk afterward makes residency
// unambiguous before the heap is left to go cold.
function allocateHeap(sizeMb: number): void {
  for (let i = 0; i < sizeMb; i += 1) {
    const chunk = new Uint8Array(CHUNK_BYTES);
    const block = new Uint8Array(ENTROPY_BLOCK_BYTES);
    randomFillSync(block);
    for (let off = 0; off < CHUNK_BYTES; off += ENTROPY_BLOCK_BYTES) chunk.set(block, off);
    heap.push(chunk);
  }
  for (const chunk of heap) {
    for (let off = 0; off < chunk.length; off += PAGE_BYTES) {
      chunk[off] = chunk[off]! ^ 1;
    }
  }
}

interface TouchResult {
  touchMs: number;
  touchBytes: number;
}

// Touch a random contiguous ~sliceMb slice of the cold heap: read+write one byte
// per 16 KB page across the run, faulting cold/compressed pages back in. Timed
// with performance.now() — under host memory pressure this single slice touch is
// the fault-storm probe: if it hits the same 0.3-5 s quantum as main's stalls, a
// cold-page fault storm monopolizing one thread is confirmed.
function touchSlice(sliceMb: number): TouchResult {
  const { startChunk, endChunk } = pickTouchSlice(heap.length, sliceMb);
  const start = performance.now();
  let touchBytes = 0;
  for (let i = startChunk; i < endChunk; i += 1) {
    const chunk = heap[i]!; // pickTouchSlice clamps to [0, heap.length)
    for (let off = 0; off < chunk.length; off += PAGE_BYTES) {
      chunk[off] = chunk[off]! ^ 1;
      touchBytes += PAGE_BYTES;
    }
  }
  return { touchMs: performance.now() - start, touchBytes };
}

function timedGc(): number {
  const start = performance.now();
  Bun.gc(true);
  return performance.now() - start;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const args = parseProbeArgs(process.argv.slice(2));
if (args.boostQos) boostQos();
if (args.variant !== "lean") allocateHeap(args.fatSizeMb);

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

const GC_EVERY_N_TICKS = 6; // TICK_MS = 10 s -> every 6th tick is once per minute
const MAX_WRITE_FAILURES = 10;
let firstTickAt = 0;
let tickIndex = 0;
let consecutiveWriteFailures = 0;

function writeSample(sample: ProbeSample): void {
  try {
    appendFileSync(args.outPath, JSON.stringify(sample) + "\n");
    consecutiveWriteFailures = 0;
  } catch (err) {
    consecutiveWriteFailures += 1;
    process.stderr.write(
      `[paging-probe:${args.variant}] append to ${args.outPath} failed (${String(consecutiveWriteFailures)}/${String(MAX_WRITE_FAILURES)}): ${String(err)}\n`,
    );
    // Fail loudly: a probe that can never write is a probe producing no
    // evidence — exit non-zero so the supervisor's backoff/give-up sees it,
    // rather than looping silently forever.
    if (consecutiveWriteFailures >= MAX_WRITE_FAILURES) {
      process.stderr.write(
        `[paging-probe:${args.variant}] ${String(MAX_WRITE_FAILURES)} consecutive write failures — exiting\n`,
      );
      process.exit(1);
    }
  }
}

// This setInterval IS the measurement, exactly like the health-monitor process
// sampler (see its "Why a setInterval and NOT a defineJob" note): the event-loop
// delay histogram accumulates natively in C even while JS is blocked, so a LATE
// tick is itself the signal. Routing this through a job queue would make a
// frozen probe silently starve its own sampler. This is the documented
// no-polling exception.
const timer = setInterval(() => {
  const now = Date.now();
  if (tickIndex === 0) firstTickAt = now;
  const late = lateByMs(now, firstTickAt, tickIndex);

  const touch = args.variant === "fat-touch" ? touchSlice(args.touchSliceMb) : null;
  const gcMs =
    args.variant === "fat-touch" && args.gcEachMinute && tickIndex % GC_EVERY_N_TICKS === 0
      ? timedGc()
      : null;
  const mem = readProcMemory();

  const sample: ProbeSample = {
    sampledAt: now,
    variant: args.variant,
    tickIndex,
    eventLoopP50Ms: histogram.percentile(50) / 1e6,
    eventLoopP99Ms: histogram.percentile(99) / 1e6,
    eventLoopMaxMs: histogram.max / 1e6,
    lateByMs: late,
    physFootprintMb: mem.physFootprintMb,
    residentMb: mem.residentMb,
  };
  if (touch) {
    sample.touchMs = touch.touchMs;
    sample.touchBytes = touch.touchBytes;
  }
  if (gcMs !== null) sample.gcMs = gcMs;

  histogram.reset();
  tickIndex += 1;
  writeSample(sample);
}, TICK_MS);

function shutdown(): void {
  clearInterval(timer);
  histogram.disable();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
