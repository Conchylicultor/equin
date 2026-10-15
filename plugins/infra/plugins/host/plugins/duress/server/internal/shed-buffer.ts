import { getConfig } from "@plugins/config_v2/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  duressEpisode,
  isUnderDuress,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { duressConfig } from "../../core";

// The duress shed engine. Observability choke points (trace capture, slow-op
// recording, report filing — wired in Phase C2) construct one buffer each and
// route every durable write through `admit()`. Outside a duress episode admit
// is a pass-through; during one, the first N items per cascade key persist
// through the normal durable path (the onset evidence) and the rest are held
// in a bounded in-memory buffer, replayed after the episode clears.
//
// Consumers supply `replay` (and wire `onFlushSummary` to their own
// reporting), so duress never imports reports/slow-ops/trace and stays a leaf
// primitive — the exact inversion that keeps the C2 reports→duress edge
// acyclic.
//
// Crash-loss is user-accepted: first-N is durable, the buffered tail is
// memory-only.

/** Items replayed per replay() call, so a flush never monopolizes the loop. */
const FLUSH_CHUNK = 100;

/**
 * The duress config values the engine reads per admit. Structural on purpose:
 * getConfig(duressConfig) satisfies it, and tests inject plain literals via
 * _setShedConfigForTests.
 */
export interface ShedConfigValues {
  enabled: boolean;
  persistFirstN: number;
  bufferMaxEntries: number;
  bufferMaxBytes: number;
  flushDelayMs: number;
}

export interface ShedCascadeStats {
  /** Items buffered for replay (deferred, not lost). */
  shed: number;
  /** Items dropped on buffer overflow — the count survives even when the item doesn't. */
  dropped: number;
}

/** One flush's accounting, handed to the consumer's onFlushSummary. */
export interface ShedSummary {
  kind: string;
  /** `setAt` of the latest episode that contributed to this batch (null if none tracked). */
  episodeSetAt: number | null;
  byCascade: Record<string, ShedCascadeStats>;
  /** Items successfully handed back through replay(). */
  replayed: number;
  /** Items in chunks whose replay() threw (logged, never rethrown). */
  replayErrors: number;
}

export interface ShedBufferOptions<T> {
  /** Stable buffer id, stamped on summaries and log lines (e.g. "traces"). */
  kind: string;
  /** The dedupe axis first-N counts along (trace `kind:label`, report fingerprint, …). */
  cascadeKeyOf: (item: T) => string;
  /** Re-drive the consumer's normal durable path for a flushed chunk. */
  replay: (items: T[]) => Promise<void>;
  /** Consumer-side reporting hook, called once per flush that had anything to account for. */
  onFlushSummary?: (summary: ShedSummary) => void;
}

export interface ShedBuffer<T> {
  /**
   * Route one durable write through the engine. `{persist: true}` ⇒ the caller
   * writes through its normal path; `{persist: false}` ⇒ the engine took
   * ownership (buffered, or dropped with accounting).
   */
  admit(item: T): { persist: boolean };
}

// --- Pure core -------------------------------------------------------------
//
// All bookkeeping (episode reset, first-N counting, caps, drop accounting,
// flush eligibility) lives here, deterministic over explicit inputs — no fs,
// no config, no clock, no timer — so the semantics are directly bun-testable.
// The createShedBuffer wrapper below binds it to the latch, the live config,
// and the one-shot flush timer.

interface AdmitEnv {
  underDuress: boolean;
  /** Current latch setAt, the episode identity. Null when unreadable (keep counting the tracked episode). */
  episodeSetAt: number | null;
}

interface FlushBatch<T> {
  items: T[];
  byCascade: Record<string, ShedCascadeStats>;
  episodeSetAt: number | null;
}

export interface ShedCore<T> {
  admit(item: T, cfg: ShedConfigValues, env: AdmitEnv): { persist: boolean };
  /** Anything owed to a flush — buffered items, or drop counts with no surviving item. */
  flushOwed(): boolean;
  /** Detach and return everything owed (resets the buffer + stats, keeps episode counters). */
  takeFlushBatch(): FlushBatch<T> | null;
}

export function createShedCore<T>(opts: {
  cascadeKeyOf: (item: T) => string;
  sizeOf: (item: T) => number;
}): ShedCore<T> {
  let items: T[] = [];
  let bytes = 0;
  // First-N counters for the tracked episode; reset when setAt changes.
  let perEpisodeCount = new Map<string, number>();
  // Accumulated shed/dropped accounting, reset only by takeFlushBatch — so a
  // batch spanning several un-flushed episodes reports them all at once.
  let byCascade = new Map<string, ShedCascadeStats>();
  let episodeSetAt: number | null = null;

  return {
    admit(item, cfg, env) {
      if (!env.underDuress) return { persist: true };
      if (env.episodeSetAt !== null && env.episodeSetAt !== episodeSetAt) {
        // New episode: first-N is re-granted, but items buffered under a
        // previous un-flushed episode stay owed.
        perEpisodeCount = new Map();
        episodeSetAt = env.episodeSetAt;
      }
      const key = opts.cascadeKeyOf(item);
      const seen = perEpisodeCount.get(key) ?? 0;
      perEpisodeCount.set(key, seen + 1);
      if (seen < cfg.persistFirstN) return { persist: true };

      let stats = byCascade.get(key);
      if (!stats) {
        stats = { shed: 0, dropped: 0 };
        byCascade.set(key, stats);
      }
      const size = opts.sizeOf(item);
      if (
        items.length >= cfg.bufferMaxEntries ||
        bytes + size > cfg.bufferMaxBytes
      ) {
        // Overflow drops the NEWEST incoming item: first-N already persisted
        // the onset, and the freshest storm tail has the least marginal value.
        stats.dropped += 1;
      } else {
        items.push(item);
        bytes += size;
        stats.shed += 1;
      }
      return { persist: false };
    },

    flushOwed() {
      return items.length > 0 || byCascade.size > 0;
    },

    takeFlushBatch() {
      if (items.length === 0 && byCascade.size === 0) return null;
      const batch: FlushBatch<T> = {
        items,
        byCascade: Object.fromEntries(byCascade),
        episodeSetAt,
      };
      items = [];
      bytes = 0;
      byCascade = new Map();
      return batch;
    },
  };
}

// --- Impure wrapper ---------------------------------------------------------

// One-shot flush timer, seam-able for tests. Never cancelled: the fire-time
// duress re-check makes cancellation unnecessary (a timer that fires
// mid-episode simply declines, and the next clear-observing admit re-arms).
interface FlushTimer {
  set(fn: () => Promise<void>, delayMs: number): void;
}

const realTimer: FlushTimer = {
  set: (fn, delayMs) => {
    setTimeout(() => {
      // fn (onFlushTimer) handles every failure internally and never rejects.
      // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- duress flush timer: observability-internal shed-buffer replay; spanning it re-feeds the profiler under duress
      void fn();
    }, delayMs);
  },
};
let flushTimer: FlushTimer = realTimer;

let configOverride: ShedConfigValues | null = null;

// Declared once at module eval (`defineLogSink` throws on a duplicate id): the
// shed buffer's own accounting log. The durable shed record is the duress-shed
// report; this is the buffer's diagnostic log.
const channel = defineLogSink({
  id: "duress",
  description:
    "Shed-buffer accounting prose (infra/host/duress). The durable shed record is the duress-shed report; this is the buffer's own log.",
});
function log(line: string): void {
  channel.publish(line);
}

export function createShedBuffer<T>(opts: ShedBufferOptions<T>): ShedBuffer<T> {
  const core = createShedCore<T>({
    cascadeKeyOf: opts.cascadeKeyOf,
    // Soft byte estimate; items are wire/DB payloads, JSON-serializable by
    // contract (a non-serializable item throws loudly here, at the boundary).
    // JSON.stringify really returns undefined for undefined items, despite
    // its string-typed overload — hence the widening assertion.
    sizeOf: (item) => (JSON.stringify(item) as string | undefined)?.length ?? 0,
  });
  let armed = false;
  let flushing = false;

  function readCfg(): ShedConfigValues {
    return configOverride ?? getConfig(duressConfig);
  }

  function maybeArmFlush(delayMs: number): void {
    if (armed || flushing || !core.flushOwed()) return;
    armed = true;
    flushTimer.set(onFlushTimer, delayMs);
  }

  async function onFlushTimer(): Promise<void> {
    armed = false;
    const cfg = readCfg();
    // A new episode may have started while the one-shot was pending; never
    // flush mid-episode — the next admit that observes the clear re-arms.
    if (cfg.enabled && isUnderDuress()) return;
    await runFlush();
  }

  async function runFlush(): Promise<void> {
    const batch = core.takeFlushBatch();
    if (!batch) return;
    flushing = true;
    let replayed = 0;
    let replayErrors = 0;
    try {
      for (let i = 0; i < batch.items.length; i += FLUSH_CHUNK) {
        const chunk = batch.items.slice(i, i + FLUSH_CHUNK);
        try {
          // Background lane + profiling suppression: the replay is monitoring
          // work recovering from an incident — it must neither ride the
          // interactive lane nor re-feed the profiler.
          await runInBackgroundLane(() =>
            runWithoutProfiling(() => opts.replay(chunk)),
          );
          replayed += chunk.length;
        } catch (err) {
          // Best-effort evidence recovery: a failed chunk is counted and
          // logged, and the remaining chunks still replay — never a crash loop.
          replayErrors += chunk.length;
          log(
            `${opts.kind}: replay chunk failed (${chunk.length} items): ${String(err)}`,
          );
        }
      }
    } finally {
      flushing = false;
    }
    const summary: ShedSummary = {
      kind: opts.kind,
      episodeSetAt: batch.episodeSetAt,
      byCascade: batch.byCascade,
      replayed,
      replayErrors,
    };
    try {
      opts.onFlushSummary?.(summary);
    } catch (err) {
      // The summary is the consumer's reporting hook; its failure must not
      // undo an otherwise-successful flush.
      log(`${opts.kind}: onFlushSummary threw: ${String(err)}`);
    }
  }

  return {
    admit(item) {
      const cfg = readCfg();
      if (!cfg.enabled || !isUnderDuress()) {
        maybeArmFlush(cfg.flushDelayMs);
        return { persist: true };
      }
      return core.admit(item, cfg, {
        underDuress: true,
        episodeSetAt: duressEpisode(),
      });
    },
  };
}

/** Override the config read (getConfig needs a booted registry). Pass null to restore. */
export function _setShedConfigForTests(values: ShedConfigValues | null): void {
  configOverride = values;
}

/** Capture flush arming instead of scheduling real timeouts. Pass null to restore. */
export function _setFlushTimerForTests(timer: FlushTimer | null): void {
  flushTimer = timer ?? realTimer;
}
