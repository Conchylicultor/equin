// FIRST, before any other import: declare this thread's runtime namespace from
// its argv. Modules below resolve paths from it as they load. See
// `./declare-namespace`.
import "./declare-namespace";
import {
  clearDuress,
  readDuress,
  refreshDuress,
  setDuress,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import {
  channelFileSink,
  logEnvelope,
} from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  sentinelStatusDir,
  writeSentinelVitals,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/server";
import type { SentinelVitalsRecord } from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import {
  DURESS_EPISODES_CHANNEL,
  type ClusterSample,
  type DuressEpisodeEvent,
} from "../../../core";
import {
  createOnsetDetector,
  signalsAt,
  type DetectorEvent,
  type DetectorThresholds,
  type OnsetDetector,
} from "../detector";
import { createSentinelPg, type SentinelPg } from "./pg";
import { createSampleGatherer, type SampleGatherer } from "./sample";
import type { MainToWorkerFrame, WorkerToMainFrame } from "./protocol";

// The sentinel worker — sampler + onset detector + duress-latch lifecycle on
// a dedicated Bun Worker thread (Track O Stage 5,
// research/2026-07-11-global-observability-freeze-blind-spots.md).
//
// SINGLE LATCH OWNER. Main never touches the latch: during the 2026-07-11
// 03:29 freeze the latch cleared MID-thrash because its per-tick refresh rode
// main's wedged event loop and the 60s lease lapsed. This thread has its own
// loop, so samples, trips, and — critically — lease renewals continue while
// main is frozen. If the whole process dies, the worker dies with it and the
// lease lapses within 60s: the fleet self-recovers (unchanged fail-safe).
//
// The setInterval below is the sentinel sampler's documented exception to the
// no-polling rule (see sampler.ts / the sentinel CLAUDE.md): it IS the
// diagnostic instrument for cluster duress, and anything queue- or loop-
// mediated would be starved by the congestion it measures.
//
// Import closure is deliberately lean: the latch sub-plugin barrel (node:fs +
// paths only), the sentinel status-file leaf (zod + node:fs + paths — the
// per-tick vitals file), log-channels' file half (log-files), the embedded-pg constants, sql-rows' `core` leaf
// (zod + structural types, no pg/drizzle import of its own), and the pure
// detector / gatherers. No config_v2 (thresholds arrive as frames — a worker
// has no plugin runtime), no drizzle pool, no trace engine (main mirrors trips
// into captureTrace off the critical path).

declare var self: Worker;

/** Extra info: episode identity + cause, held for lines/refresh/max-hold. */
interface Episode {
  setAt: number;
  reason: string;
  // The elevated signal names at trip — carried to the clear frame as the
  // duress-episode report's cause-signature (its fingerprint axis). An adopted
  // episode (respawn mid-episode) has no trip event, so it carries [].
  elevated: string[];
}

let cadenceMs = 0;
let thresholds: DetectorThresholds | null = null;
let maxEpisodeHoldMs = Number.POSITIVE_INFINITY;
let detector: OnsetDetector | null = null;
let episode: Episode | null = null;
let pg: SentinelPg | null = null;
let gatherer: SampleGatherer | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let syntheticSample: ClusterSample | null = null;

// The worker is the sole writer of the duress-episodes channel file (single
// writer per channel file); the sentinel is main-only, so the lines land on
// main's log dir. Lazy: created on first transition, not at module eval.
// The worker is the sole writer of the durable duress-episodes channel file. A
// worker thread has no plugin graph (no host services), so it writes the
// channel's FILE directly — the same declared sink and envelope the desktop's
// log persistence writes; import-safe because the path resolves on first write.
const episodesFile = channelFileSink({
  id: DURESS_EPISODES_CHANNEL,
  description:
    "Sentinel duress trip/clear lines (one per episode transition). Each episode files the duress-episode report and renders as a timeline duress band.",
});

function emit(frame: WorkerToMainFrame): void {
  self.postMessage(frame);
}

function log(line: string): void {
  emit({ type: "log", line });
}

function writeEpisodeLine(
  kind: DuressEpisodeEvent["kind"],
  reason: string,
  episodeSetAt: number,
): void {
  const event: DuressEpisodeEvent = {
    atMs: Date.now(),
    kind,
    reason,
    episodeSetAt,
  };
  episodesFile.append(
    logEnvelope({
      t: Date.now(),
      stream: "stdout",
      line: JSON.stringify(event),
    }),
  );
}

async function endEpisode(forced: boolean, wall: number): Promise<void> {
  await clearDuress();
  // Capture the ending episode BEFORE nulling it — both the clear line and the
  // enriched clear frame (the duress-episode report's payload) read from it.
  const ended = episode;
  if (ended) {
    writeEpisodeLine(
      "clear",
      forced ? `max-episode-hold: ${ended.reason}` : ended.reason,
      ended.setAt,
    );
  }
  episode = null;
  emit({
    type: "clear",
    forced,
    ...(ended
      ? {
          reason: ended.reason,
          elevated: ended.elevated,
          episodeSetAt: ended.setAt,
          wall,
        }
      : {}),
  });
}

/**
 * The vitals record for this tick: the readings through the detector's own
 * `signalsAt`, the limits from the thresholds it used, and its trip state.
 */
function vitalsRecord(
  sample: ClusterSample,
  t: DetectorThresholds,
  tripped: boolean,
): SentinelVitalsRecord {
  const { readings, elevated, holding } = signalsAt(sample, t);
  return {
    pid: process.pid,
    wall: sample.wall,
    cadenceMs,
    signals: {
      decompressionsPerSec: {
        value: readings.decompressionsPerSec,
        limit: t.onDecompressionsPerSec,
      },
      // The detector reads a pg-unreadable tick as 0 locks (neither elevated
      // nor calm-blocking); the row says it could not read them instead.
      locksWaiting: {
        value: sample.pgLocksWaiting === null ? null : readings.locksWaiting,
        limit: t.onLocksWaiting,
      },
      blkReadDeltaMs: {
        value: readings.blkReadDeltaMs,
        limit: t.onBlkReadDeltaMs,
      },
      slowBackends: { value: readings.slowBackends, limit: t.onSlowBackends },
    },
    elevated,
    holding,
    tripped,
    context: {
      loadRatio: readings.loadRatio,
      freeMemMb: sample.freeMemMb ?? null,
      inFlightBuilds: sample.inFlightBuilds,
      runningBackends: sample.runningBackends,
      disk: sample.disk ?? null,
    },
  };
}

/**
 * Publish this tick's reading to the host-global vitals file every backend
 * serves. A failed write is logged and never fails the tick: the latch below
 * is what this thread exists for, and the row shows a missing reading as stale.
 */
let vitalsWriting = false;

async function writeVitals(
  sample: ClusterSample,
  t: DetectorThresholds,
): Promise<void> {
  // One write at a time (they share a temp file): a tick that finds the last
  // write still in flight skips its reading — the row shows the newer one next.
  if (vitalsWriting) return;
  vitalsWriting = true;
  try {
    await writeSentinelVitals(
      sentinelStatusDir.path,
      vitalsRecord(sample, t, detector?.tripped ?? false),
    );
  } catch (err) {
    log(`vitals write failed: ${String(err)}`);
  } finally {
    vitalsWriting = false;
  }
}

function processSample(sample: ClusterSample): void {
  if (!detector || !thresholds) return;
  // Best-effort mirror to main (ring + listeners). postMessage buffers while
  // main is wedged; the sample carries its own `wall`, so late delivery is
  // harmless — and nothing below waits on main.
  emit({ type: "sample", sample });
  latestSample = sample;
  latchStep.trigger();
}

/** The newest sample not yet fed to the detector; older unfed ones are dropped. */
let latestSample: ClusterSample | null = null;

/**
 * Feed the detector and write the latch, one step at a time and always on the
 * NEWEST sample. Ticks can overlap (a slow gather) and the latch writes are
 * async: run unordered, a clear could land before the set it follows. Queued
 * per tick, a latch write stalled on the disk — exactly under duress — would
 * pile up ticks without bound and feed stale samples in order on recovery. So
 * at most one step runs and one is pending, and the pending one takes whatever
 * sample is newest when it starts (the detector skips the ones in between).
 */
const latchStep = createCoalescer({
  run: async () => {
    const sample = latestSample;
    latestSample = null;
    if (!sample || !detector || !thresholds) return;
    const t = thresholds;
    try {
      await applyDetector(detector.feed(sample, t, cadenceMs), sample);
    } catch (err) {
      // A failing step must not stop the next one, but it is never silent.
      log(`latch step failed: ${String(err)}`);
    }
    // After the latch work, so the file's trip state is this step's outcome.
    await writeVitals(sample, t);
  },
});

/** The latch lifecycle for one detector outcome: set on trip, clear, or refresh. */
async function applyDetector(
  event: DetectorEvent,
  sample: ClusterSample,
): Promise<void> {
  if (!detector) return;
  if (event?.kind === "trip") {
    const reason = `cluster-onset: ${event.elevated.join(", ")}`;
    // The latch's own setAt is the episode identity — take it from what was
    // written rather than re-deriving, so lines and shed first-N keys can
    // never disagree.
    const { setAt } = await setDuress(reason);
    episode = { setAt, reason, elevated: event.elevated };
    writeEpisodeLine("trip", reason, setAt);
    emit({
      type: "trip",
      runUpMs: event.runUpMs,
      signals: event.signals,
      elevated: event.elevated,
      wall: sample.wall,
    });
    return;
  }

  if (event?.kind === "clear") {
    await endEpisode(false, sample.wall);
    return;
  }

  if (detector.tripped && episode) {
    if (Date.now() - episode.setAt > maxEpisodeHoldMs) {
      // Safety bound: a mis-calibrated threshold must not latch the fleet
      // indefinitely. Force-clear and re-evaluate from scratch — if the
      // elevation is real the fresh detector re-trips after onTicks (which
      // re-grants shed first-N per key: a small persistence burst, accepted).
      log(
        `max-episode-hold exceeded (${String(maxEpisodeHoldMs)}ms) — forcing clear + re-eval`,
      );
      await endEpisode(true, sample.wall);
      detector = createOnsetDetector();
      return;
    }
    // Mid-episode tick: keep the latch's freshness lease alive. THE critical
    // path this worker exists for.
    await refreshDuress();
  }
}

async function tick(): Promise<void> {
  const g = gatherer;
  if (!g) return;
  try {
    const sample = syntheticSample ?? (await g.gather());
    processSample(sample);
  } catch (err) {
    // A failing tick must not kill the interval, but it is never silent.
    log(`tick failed: ${String(err)}`);
  }
}

/** Set by the first init frame; a second one is ignored. */
let initStarted = false;
/** Set by a stop frame — one may arrive while init still reads the latch. */
let stopping = false;

async function handleInit(
  frame: Extract<MainToWorkerFrame, { type: "init" }>,
): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  cadenceMs = frame.cadenceMs;
  thresholds = frame.thresholds;
  maxEpisodeHoldMs = frame.maxEpisodeHoldMs;
  // The namespace was declared from argv before any import ran
  // (`./declare-namespace`); it names the embedded-cluster database too.
  pg = createSentinelPg(runtimeNamespace(), log);
  gatherer = createSampleGatherer(pg, log);

  // An existing latch is the previous worker's episode (a stop leaves it in
  // place). Fresh: adopt it — seed the detector tripped so it keeps refreshing
  // the lease and eventually emits the clear; no trip line, the previous
  // worker already wrote it. Lapsed (nobody refreshed it for a lease): close
  // it, so its trip line does not stay open forever.
  const reading = await readDuress();
  if (stopping) return;
  const latch = reading?.latch ?? null;
  if (latch && reading?.fresh) {
    detector = createOnsetDetector({ tripped: true });
    episode = { setAt: latch.setAt, reason: latch.reason, elevated: [] };
    log(
      `adopted existing duress latch (setAt=${String(latch.setAt)}, reason=${latch.reason})`,
    );
  } else if (latch) {
    await clearDuress();
    writeEpisodeLine("clear", `lease-lapsed: ${latch.reason}`, latch.setAt);
    log(
      `closed a lapsed duress latch (setAt=${String(latch.setAt)}, reason=${latch.reason})`,
    );
  }
  detector ??= createOnsetDetector();
  if (stopping) return;

  interval = setInterval(() => {
    void tick();
  }, cadenceMs);
  emit({ type: "ready" });
}

async function handleStop(): Promise<void> {
  stopping = true;
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  // A stopping sentinel leaves a tripped latch in place. Main restarts on every
  // deploy, and clearing here ended the episode at full load: the successor
  // started calm and re-tripped `onTicks` later, and every build held at the
  // duress gate was let in all at once in between (2026-10-28: 16 of 32 clears
  // were main restarts, at up to 6x the clear threshold). The successor adopts
  // the fresh latch at init; with none, the lease lapses on its own and the
  // next init closes the episode.
  detector = null;
  await pg?.end();
  emit({ type: "stopped" });
}

self.onmessage = (event: MessageEvent) => {
  const frame = event.data as MainToWorkerFrame;
  switch (frame.type) {
    case "init":
      void handleInit(frame);
      break;
    case "config":
      thresholds = frame.thresholds;
      maxEpisodeHoldMs = frame.maxEpisodeHoldMs;
      break;
    case "stop":
      void handleStop();
      break;
    case "__sample":
      syntheticSample = frame.sample;
      break;
  }
};
