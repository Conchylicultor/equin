// FIRST, before any other import: declare this thread's runtime namespace from
// its argv. Modules below resolve paths from it as they load. See
// `./declare-namespace`.
import "./declare-namespace";
import {
  clearDuress,
  isUnderDuress,
  readDuress,
  refreshDuress,
  setDuress,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
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
// per-tick vitals file), log-channels, the embedded-pg constants, sql-rows' `core` leaf
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
// The worker is the sole writer of the durable duress-episodes channel. Declared
// once at module eval (`defineLogSink` throws on a duplicate id); import-safe
// because the file sink is built lazily on first publish.
const episodesChannel = defineLogSink({
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
  episodesChannel.publish(JSON.stringify(event));
}

function endEpisode(forced: boolean, wall: number): void {
  clearDuress();
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
  const { readings, elevated } = signalsAt(sample, t);
  return {
    pid: process.pid,
    wall: sample.wall,
    cadenceMs,
    signals: {
      loadRatio: { value: readings.loadRatio, limit: t.onLoadRatio },
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
    tripped,
    context: {
      freeMemMb: sample.freeMemMb ?? null,
      inFlightBuilds: sample.inFlightBuilds,
      runningBackends: sample.runningBackends,
    },
  };
}

/**
 * Publish this tick's reading to the host-global vitals file every backend
 * serves. A failed write is logged and never fails the tick: the latch below
 * is what this thread exists for, and the row shows a missing reading as stale.
 */
function writeVitals(sample: ClusterSample, t: DetectorThresholds): void {
  try {
    writeSentinelVitals(
      sentinelStatusDir.path,
      vitalsRecord(sample, t, detector?.tripped ?? false),
    );
  } catch (err) {
    log(`vitals write failed: ${String(err)}`);
  }
}

function processSample(sample: ClusterSample): void {
  if (!detector || !thresholds) return;
  // Best-effort mirror to main (ring + listeners). postMessage buffers while
  // main is wedged; the sample carries its own `wall`, so late delivery is
  // harmless — and nothing below waits on main.
  emit({ type: "sample", sample });

  const t = thresholds;
  applyDetector(detector.feed(sample, t, cadenceMs), sample);
  // After the latch work, so the file's trip state is this tick's outcome.
  writeVitals(sample, t);
}

/** The latch lifecycle for one detector outcome: set on trip, clear, or refresh. */
function applyDetector(event: DetectorEvent, sample: ClusterSample): void {
  if (!detector) return;
  if (event?.kind === "trip") {
    const reason = `cluster-onset: ${event.elevated.join(", ")}`;
    setDuress(reason);
    // The latch's own setAt is the episode identity — read it back rather
    // than re-deriving, so lines and shed first-N keys can never disagree.
    const setAt = readDuress()?.setAt ?? Date.now();
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
    endEpisode(false, sample.wall);
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
      endEpisode(true, sample.wall);
      detector = createOnsetDetector();
      return;
    }
    // Mid-episode tick: keep the latch's freshness lease alive. THE critical
    // path this worker exists for.
    refreshDuress();
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

function handleInit(frame: Extract<MainToWorkerFrame, { type: "init" }>): void {
  if (interval) return;
  cadenceMs = frame.cadenceMs;
  thresholds = frame.thresholds;
  maxEpisodeHoldMs = frame.maxEpisodeHoldMs;
  // The namespace was declared from argv before any import ran
  // (`./declare-namespace`); it names the embedded-cluster database too.
  pg = createSentinelPg(runtimeNamespace(), log);
  gatherer = createSampleGatherer(pg, log);

  // Adopt a fresh existing latch (this is a respawn mid-episode): seed the
  // detector tripped so it keeps refreshing the lease and eventually emits
  // the clear. No trip line — the previous worker already wrote it.
  if (isUnderDuress()) {
    const latch = readDuress();
    if (latch) {
      detector = createOnsetDetector({ tripped: true });
      episode = { setAt: latch.setAt, reason: latch.reason, elevated: [] };
      log(
        `adopted existing duress latch (setAt=${String(latch.setAt)}, reason=${latch.reason})`,
      );
    }
  }
  detector ??= createOnsetDetector();

  interval = setInterval(() => {
    void tick();
  }, cadenceMs);
  emit({ type: "ready" });
}

async function handleStop(): Promise<void> {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  // A stopping sentinel must not leave the fleet latched: the lease would
  // expire in 60s anyway, but an explicit clear removes the window entirely.
  if (detector?.tripped && episode) endEpisode(false, Date.now());
  detector = null;
  await pg?.end();
  emit({ type: "stopped" });
}

self.onmessage = (event: MessageEvent) => {
  const frame = event.data as MainToWorkerFrame;
  switch (frame.type) {
    case "init":
      handleInit(frame);
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
