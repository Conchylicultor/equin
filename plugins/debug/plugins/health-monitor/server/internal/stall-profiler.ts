import {
  recordEventLoopStall,
  recordLoopStallEvidence,
} from "@plugins/debug/plugins/stall-monitor/server";
import {
  loopStallsSince,
  profilerNowMs,
  type LoopStall,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  claimStackSampler,
  frameKey,
  type StackSample,
  type StackSampler,
} from "@plugins/infra/plugins/stack-sampler/core";
import type {
  StallSection,
  StallLeaf,
  StallStack,
} from "@plugins/debug/plugins/trace/plugins/stall/core";
import { PROBE_PERIOD_MS } from "./probe-cadence";

// On-stall stack-trace capture. Folded into the health sampler's tick.
//
// Mechanism: JSC's sampling profiler runs on a SEPARATE thread, so it keeps
// sampling the blocked main-thread JS stack DURING a synchronous block — exactly
// the window where an on-demand "start profiling" request could never even be
// processed. We claim it once at sampler boot (main only) and drain it every
// tick. A drain returns only the samples since the last one, so a single
// drain-per-tick bounds memory AND aligns the captured samples to the same window
// as `eventLoopMaxMs`. The profiler itself — and every fact about bun:jsc's API
// (no stop, the directory-only argument, the varying rate, which frames are
// missing) — is owned by `infra/stack-sampler`; see its CLAUDE.md.
//
// The tick's window is NOT the block. A 10 s window holding a 3 s block holds
// 7 s of ordinary work too, and its samples summed say nothing about what
// blocked the thread — the 2026-11-12 04:00 freeze on main (3.2 s) was filed
// with 2,261 samples over 10 s and no dominant stack, while the probe's own
// 2.8 s block a few seconds before had taken 4 samples. So the freeze's
// evidence is the samples taken during the BLOCK only, placed by the loop
// probe's registered stalls (`freezeEvidence`), exactly as a short stall's is.
// The histogram only says how long the loop blocked, never when.
//
// On a stall the aggregated stacks are handed to `debug/stall-monitor` via
// `recordEventLoopStall`, NOT dumped to a dead-end JSONL. This sampler only
// DETECTS + AGGREGATES (drain + threshold gate + aggregateTraces); stall-monitor
// owns filing the trace AND the report. The trace surfaces in Debug → Slow Events
// like every other slow signal (rendered by the `trace/plugins/stall` event class
// as a histogram lane) and the report reaches the bell + Debug → Reports.
//
// The profiler has no stop, so `stopStallProfiler()` just disarms our consumer
// (we stop draining/capturing) and the JSC sampler thread idles harmlessly for
// the rest of the process. The real sample rate is derived per-dump from
// nSamples/window, never assumed.

// Matches the "stalls > 3 s" cohort the investigation tracks in health.jsonl.
const STALL_THRESHOLD_MS = 3_000;

// A shorter block the loop probe registered gets its OWN stacks (a `stall` trace,
// no report) from this long: the slow-op bar, so a block that could make any op
// look slow names what ran. Measured on main (2026-11-05): ~9% of 10 s windows
// hold a 0.5–3 s block, and 79% of slow `db` samples overlapped one.
const STALL_EVIDENCE_MS = 500;

// Cap the per-trace stack signature so a deep recursion can't bloat a line.
const MAX_SIGNATURE_FRAMES = 40;

const TOP_LEAVES = 15;
const TOP_STACKS = 10;

let sampler: StackSampler | null = null;

// The samples drained since the sampler tick last consumed them, and the batch it
// consumed before that. A registered stall drains early (so its trace is captured
// right after the block, with the spans that were in flight), and a sampler tick
// may run first after a block — before the probe registers it — so a stall's
// samples are in one of the two.
let pending: StackSample[] = [];
let previousWindow: StackSample[] = [];

function collect(): void {
  if (!sampler) return;
  const drained = sampler.drain();
  if (drained.length > 0) pending = pending.concat(drained);
}

// Stack-sample observers — the `onSlowSpan` shape. Called once per drain (every
// 10 s tick while armed) with that window's samples. Armed always on main, and on
// another backend only once it has shown an elevated tick, so an observer there
// sees nothing until then. An observer must be cheap and must not throw.
export type StackSampleObserver = (
  samples: readonly StackSample[],
  windowMs: number,
) => void;
const stackSampleObservers = new Set<StackSampleObserver>();
export function onStackSamples(cb: StackSampleObserver): () => void {
  stackSampleObservers.add(cb);
  return () => stackSampleObservers.delete(cb);
}

// Render a source path relative to the worktree root so keys stay readable and
// stable (the absolute prefix is noise and machine-specific).
function shortenSource(sourceURL: string): string {
  const cwd = process.cwd();
  if (sourceURL.startsWith(cwd + "/")) return sourceURL.slice(cwd.length + 1);
  return sourceURL;
}

// Generic "hottest N entries of a histogram". The value type is open so a bucket
// can carry more than its count (stacks carry their representative frame keys);
// `countOf` is the only thing this needs to know about it.
function topN<V, T>(
  counts: Map<string, V>,
  total: number,
  n: number,
  countOf: (value: V) => number,
  build: (key: string, value: V, count: number, pct: number) => T,
): T[] {
  return [...counts.entries()]
    .sort((a, b) => countOf(b[1]) - countOf(a[1]))
    .slice(0, n)
    .map(([key, value]) => {
      const count = countOf(value);
      return build(key, value, count, Math.round((count / total) * 1000) / 10);
    });
}

// One stack-signature bucket: how many samples sat on this call path, plus the
// resolved frame keys of the FIRST trace seen with it.
//
// Why carry the frames at all: `stack` is names-only (it is the report's dedup
// grain — line-free, robust to edits), so nothing downstream can attribute it to
// a source location. Without this, `topLeaves` and `topStacks` are two
// INDEPENDENT histograms and the leaf↔stack association is lost: a consumer
// labelling the stall picks a leaf from one population while the fingerprint
// names a stack from the other, so the label can describe a different stall than
// the one being reported. That really happened — a `spawn`-rooted freeze (7/15
// samples) was titled with a 1-sample drizzle frame. Carrying the frames lets a
// consumer attribute the dominant stack using only THAT stack's own evidence.
//
// "Representative" is meant literally — these are ONE real sample's resolved
// keys, not a canonical attribution for the bucket. `frame.line` is the sample's
// EXECUTING line, not the function's declaration line, so two traces sharing a
// name-only signature can resolve to different keys: the Jul-16 stall's own
// evidence carries both `is @ …/entity.js:7` and `is @ …/entity.js:18` as
// separate leaves of the same `is` function. Keeping the first trace's keys is
// still enough for the job — a consumer wants "which subsystem is this call path
// in", and any real sample on the path answers that. Don't read `frames` as "the"
// position of the path; read it as "a" position on it.
interface StackBucket {
  count: number;
  frames: string[];
}

export function aggregateTraces(
  traces: readonly Pick<StackSample, "timestamp" | "frames">[],
): {
  topLeaves: StallLeaf[];
  topStacks: StallStack[];
} {
  const leafCounts = new Map<string, number>();
  const stackCounts = new Map<string, StackBucket>();
  let total = 0;

  for (const trace of traces) {
    const frames = trace.frames;
    if (!frames[0]) continue;
    total += 1;

    // Slice ONCE and derive both the leaf and the signature from the kept
    // frames, so `frames[0] === the leaf counted in topLeaves` holds by
    // construction rather than by two call sites agreeing.
    const kept = frames.slice(0, MAX_SIGNATURE_FRAMES);

    const leaf = frameKey(kept[0]!, shortenSource);
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);

    // Full collapsed stack signature, innermost → outermost (names only — keeps
    // it compact and groups by call path rather than exact source position).
    const signature = kept
      .map((f) => (f.name && f.name.length > 0 ? f.name : "?"))
      .join(" ← ");
    const seen = stackCounts.get(signature);
    if (seen) seen.count += 1;
    else
      stackCounts.set(signature, {
        count: 1,
        frames: kept.map((f) => frameKey(f, shortenSource)),
      });
  }

  if (total === 0) return { topLeaves: [], topStacks: [] };

  return {
    topLeaves: topN(
      leafCounts,
      total,
      TOP_LEAVES,
      (n) => n,
      (key, _bucket, count, pct) => ({ key, count, pct }),
    ),
    topStacks: topN(
      stackCounts,
      total,
      TOP_STACKS,
      (bucket) => bucket.count,
      (stack, bucket, count, pct) => ({
        stack,
        count,
        pct,
        frames: bucket.frames,
      }),
    ),
  };
}

export function startStallProfiler(): void {
  if (sampler) return;
  sampler = claimStackSampler("health-monitor");
}

// No JSC "stop" exists; we simply disarm the consumer. The sampler thread idles
// for the rest of the process lifetime, and a later `startStallProfiler()`
// re-claims the same handle (same owner).
export function stopStallProfiler(): void {
  sampler = null;
  pending = [];
  previousWindow = [];
}

/**
 * The samples taken during one registered stall: the block began at most one
 * probe period before the late tick was due (`t0`), and ended when it ran (`t1`).
 * A sample the clock could not place is left out — never guessed into a block.
 */
export function samplesInStall(
  samples: readonly StackSample[],
  stall: LoopStall,
  probePeriodMs: number,
): StackSample[] {
  const from = stall.t0 - probePeriodMs;
  return samples.filter(
    (s) => s.atMs !== null && s.atMs >= from && s.atMs <= stall.t1,
  );
}

/**
 * The evidence of a freeze the 10 s window's histogram saw (`eventLoopMaxMs`):
 * the samples of the registered block that explains it, or — when none of the
 * probe's registered stalls in the window is long enough to be it — the whole
 * window's, said so (`scope: "window"`), never passed off as the block's.
 *
 * A registered stall `[t0, t1]` (t0 = when the late probe tick was due) is a
 * block of at most `t1 - t0 + probePeriodMs`; it explains the freeze when that
 * reaches `eventLoopMaxMs` within one more probe period (the two clocks tick
 * differently). The longest such stall is the block.
 */
export function freezeEvidence(
  // This window's samples, and the batch drained before it (a short stall's
  // early drain may have moved the block's first samples there).
  samples: { window: readonly StackSample[]; earlier: readonly StackSample[] },
  stalls: readonly LoopStall[],
  eventLoopMaxMs: number,
  windowMs: number,
  probePeriodMs: number,
): { section: StallSection; block: LoopStall | null } {
  let block: LoopStall | null = null;
  for (const s of stalls) {
    if (s.t1 - s.t0 + 2 * probePeriodMs < eventLoopMaxMs) continue;
    if (!block || s.t1 - s.t0 > block.t1 - block.t0) block = s;
  }
  const windowSampleRateHz = rateHz(samples.window.length, windowMs);
  if (!block) {
    return {
      block,
      section: {
        nSamples: samples.window.length,
        sampleRateHz: windowSampleRateHz,
        scope: "window",
        spanMs: windowMs,
        windowSampleRateHz,
        ...aggregateTraces(samples.window),
      },
    };
  }
  const inBlock = samplesInStall(
    samples.earlier.concat(samples.window),
    block,
    probePeriodMs,
  );
  const spanMs = block.t1 - block.t0 + probePeriodMs;
  return {
    block,
    section: {
      nSamples: inBlock.length,
      sampleRateHz: rateHz(inBlock.length, spanMs),
      scope: "block",
      spanMs,
      windowSampleRateHz,
      ...aggregateTraces(inBlock),
    },
  };
}

function rateHz(n: number, spanMs: number): number {
  return spanMs > 0 ? Math.round(n / (spanMs / 1000)) : 0;
}

/**
 * A stall the loop probe just registered (called from its tick, right after the
 * block). One of STALL_EVIDENCE_MS up to the freeze threshold is attributed from
 * its own samples — only the block's, not the 10 s window's — and captured as a
 * `stall` trace; a freeze stays the sampler tick's (window stacks + report).
 */
export function noteRegisteredStall(
  stall: LoopStall,
  probePeriodMs: number,
): void {
  if (!sampler) return;
  const durationMs = stall.t1 - stall.t0;
  // The 10 s window's eventLoopMaxMs reads the same block up to one probe
  // period longer than this lateness, so a block near the threshold belongs to
  // the freeze path — never filed by both.
  if (
    durationMs < STALL_EVIDENCE_MS ||
    durationMs > STALL_THRESHOLD_MS - probePeriodMs
  )
    return;
  collect();
  const inStall = samplesInStall(
    previousWindow.concat(pending),
    stall,
    probePeriodMs,
  );
  const { topLeaves, topStacks } = aggregateTraces(inStall);
  // No sample in the block: the thread was not running JS (descheduled on a
  // loaded host, or native work the sampler cannot see). Still evidence — a
  // trace with nSamples 0 says the block was not this process's JS.
  const spanMs = durationMs + probePeriodMs;
  recordLoopStallEvidence(
    {
      nSamples: inStall.length,
      sampleRateHz: rateHz(inStall.length, spanMs),
      scope: "block",
      spanMs,
      topLeaves,
      topStacks,
    },
    durationMs,
    STALL_EVIDENCE_MS,
  );
}

// Always drain (bounds memory). If the window stalled past the threshold, take
// the block's own samples (`freezeEvidence`) and hand the section to
// stall-monitor (which files the trace + report) — a block with no sample in it
// included, as the finding it is. `windowMs` is the actual wall-time since the
// previous drain (the tick fires late after a block).
export function drainAndMaybeDump(
  eventLoopMaxMs: number,
  windowMs: number,
): void {
  if (!sampler) return;
  collect();
  const traces = pending;
  const before = previousWindow;
  previousWindow = pending;
  pending = [];
  // Every drained batch, stall or not: what ran on the thread this window. Until
  // this seam the samples of a healthy window were thrown away, so "what does this
  // thread spend its time on" could only be answered during a freeze.
  if (traces.length > 0) {
    for (const observer of stackSampleObservers) observer(traces, windowMs);
  }

  if (eventLoopMaxMs <= STALL_THRESHOLD_MS) return; // not a stall — discard

  const windowStartMs = profilerNowMs() - windowMs;
  const { section, block } = freezeEvidence(
    { window: traces, earlier: before },
    loopStallsSince(windowStartMs - PROBE_PERIOD_MS),
    eventLoopMaxMs,
    windowMs,
    PROBE_PERIOD_MS,
  );

  // Hand the evidence to the alert plugin, which owns both the trace (critical,
  // stable-labelled) and the deduped `event-loop-stall` report. The span it
  // looks for covering work in is the block's when one was placed.
  recordEventLoopStall(
    section,
    eventLoopMaxMs,
    STALL_THRESHOLD_MS,
    block ? profilerNowMs() - (block.t0 - PROBE_PERIOD_MS) : windowMs,
  );
}
