import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import {
  SITE_REPORT_LIMITS,
  type PageDropReason,
  type SiteReportEntry,
  type SiteReportsResponse,
} from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";

const encoder = new TextEncoder();
/** One entry's serialized size, its count at the widest it can be. */
function entryBytes(report: BatchedReport): number {
  return encoder.encode(
    JSON.stringify({ ...report, count: SITE_REPORT_LIMITS.maxCount }),
  ).length;
}

/** One report as the page hands it to the batcher, before its count is folded in. */
export type BatchedReport = Omit<SiteReportEntry, "count">;

/** The page's own bounds — one visit (page load) never sends more than these allow. */
export interface BatcherLimits {
  /** Distinct fingerprints one visit sends; past it an occurrence is only counted locally. */
  maxDistinct: number;
  /** POSTs one visit makes, failures included. */
  maxPosts: number;
  /** Reports in one POST (the intake's `maxBatch`). */
  maxBatch: number;
  /**
   * One POST's serialized body, in UTF-8 bytes (the intake's `maxBodyBytes` —
   * also a browser's keepalive bound, the pagehide flush's): a batch stops
   * short of it, the rest go next.
   */
  maxBodyBytes: number;
  /** How long the first queued report waits for others to join its batch. */
  batchDelayMs: number;
  /** The longest back-off between two failed sends. */
  maxBackoffMs: number;
  /** Consecutive failed sends after which the visit stops sending. */
  maxFailures: number;
}

export const BATCHER_LIMITS: BatcherLimits = {
  maxDistinct: 20,
  maxPosts: 10,
  maxBatch: SITE_REPORT_LIMITS.maxBatch,
  maxBodyBytes: SITE_REPORT_LIMITS.maxBodyBytes,
  batchDelayMs: 5_000,
  maxBackoffMs: 5 * 60_000,
  maxFailures: 5,
};

export interface BatcherDeps {
  /** One POST of a batch. Throws on a network error or a non-2xx answer. */
  send(
    entries: SiteReportEntry[],
    dropped: PageDrops,
    opts: { keepalive: boolean },
  ): Promise<SiteReportsResponse>;
  /** One-shot timer. */
  schedule(fn: () => void, delayMs: number): void;
  /** Where a failure is said (the console): never a report, which would loop. */
  warn(message: string): void;
  limits?: BatcherLimits;
}

interface Held {
  report: BatchedReport;
  /** Occurrences not yet delivered. */
  unsent: number;
}

/** What the page counted instead of filing, per reason (the body's `dropped`). */
export type PageDrops = Partial<Record<PageDropReason, number>>;

export interface ReportBatcher {
  /**
   * Count one measurement the page judged not to be one (a load no one waited
   * for): it rides the next batch as a count under its reason, so the intake's
   * drop counts show it — never a report.
   */
  drop(reason: PageDropReason): void;
  /** Take one occurrence: `batched` (queued or counted) or `dropped` (over the visit's caps). */
  add(report: BatchedReport): "batched" | "dropped";
  /** Send what is waiting now — `pagehide` passes `keepalive` so it outlives the page. */
  flush(opts?: { keepalive?: boolean }): Promise<void>;
  /** For tests and the console: what the visit has done so far. */
  state(): {
    distinct: number;
    posts: number;
    stopped: boolean;
    droppedLocally: number;
  };
}

/**
 * The website's report channel, bounded on the page:
 *
 * - **dedupe** — one entry per fingerprint (kind, source, message, the top of
 *   its stack); a repeat only bumps that entry's count, which rides the next
 *   batch;
 * - **caps** — at most `maxDistinct` fingerprints and `maxPosts` POSTs per
 *   visit; beyond them an occurrence is counted locally and never sent;
 * - **batch** — the first queued report waits `batchDelayMs` for the others;
 * - **back off** — a failed POST doubles the wait (up to `maxBackoffMs`), a
 *   rate-limited one waits what the server said, and `maxFailures` failures
 *   in a row stop the visit.
 *
 * Pure over its injected send and timer.
 */
export function createReportBatcher(deps: BatcherDeps): ReportBatcher {
  const limits = deps.limits ?? BATCHER_LIMITS;
  const held = new Map<number, Held>();
  /** Drop counts not yet delivered. */
  let unsentDrops: PageDrops = {};
  let posts = 0;
  let failures = 0;
  let stopped = false;
  let droppedLocally = 0;
  let timerArmed = false;
  // A flush supersedes the timer armed before it (its back-off decides the
  // next one): a stale timer firing later does nothing.
  let timerGeneration = 0;
  let backoffMs = limits.batchDelayMs;
  let sending = false;
  // A flush asked for while one is in flight: run again once it lands (with
  // keepalive when the asker was the page going away), never silently skipped.
  let rerun: { keepalive: boolean } | null = null;

  function arm(delayMs: number): void {
    if (timerArmed || stopped) return;
    timerArmed = true;
    const generation = timerGeneration;
    deps.schedule(() => {
      if (generation !== timerGeneration) return;
      void flush();
    }, delayMs);
  }

  function keyOf(r: BatchedReport): number {
    const stack = typeof r.data.stack === "string" ? r.data.stack : "";
    return hash53(
      `${r.kind}\n${r.source}\n${r.message}\n${stack.slice(0, 300)}`,
    );
  }

  function add(report: BatchedReport): "batched" | "dropped" {
    if (stopped) {
      droppedLocally += 1;
      return "dropped";
    }
    const key = keyOf(report);
    const known = held.get(key);
    if (known) {
      known.unsent += 1;
    } else {
      if (held.size >= limits.maxDistinct) {
        droppedLocally += 1;
        return "dropped";
      }
      held.set(key, { report, unsent: 1 });
    }
    arm(limits.batchDelayMs);
    return "batched";
  }

  function drop(reason: PageDropReason): void {
    if (stopped) {
      droppedLocally += 1;
      return;
    }
    unsentDrops[reason] = (unsentDrops[reason] ?? 0) + 1;
    arm(limits.batchDelayMs);
  }

  function hasDrops(d: PageDrops): boolean {
    return Object.keys(d).length > 0;
  }

  /** Put undelivered drop counts back, to ride the next batch. */
  function restoreDrops(d: PageDrops): void {
    for (const [reason, n] of Object.entries(d) as [PageDropReason, number][]) {
      unsentDrops[reason] = (unsentDrops[reason] ?? 0) + n;
    }
  }

  async function flush(opts?: { keepalive?: boolean }): Promise<void> {
    if (stopped) return;
    timerGeneration += 1;
    timerArmed = false;
    if (sending) {
      rerun = {
        keepalive: (rerun?.keepalive ?? false) || (opts?.keepalive ?? false),
      };
      return;
    }
    if (posts >= limits.maxPosts) {
      stopped = true;
      // What can no longer be sent is counted on the page, like a report.
      for (const n of Object.values(unsentDrops)) droppedLocally += n ?? 0;
      unsentDrops = {};
      return;
    }
    const batch: { held: Held; count: number }[] = [];
    // The drop counts ride whole (a few short keys).
    const drops: PageDrops = {};
    for (const [reason, n] of Object.entries(unsentDrops) as [
      PageDropReason,
      number,
    ][]) {
      drops[reason] = Math.min(n, SITE_REPORT_LIMITS.maxCount);
    }
    // `{"reports":[` + `],"automated":false}` (the channel's flag, at its
    // longest) and the drop counts, then each entry and its comma.
    let bodyBytes =
      32 + encoder.encode(`,"dropped":${JSON.stringify(drops)}`).length;
    for (const h of held.values()) {
      if (h.unsent === 0) continue;
      const size = entryBytes(h.report) + 1;
      if (batch.length > 0 && bodyBytes + size > limits.maxBodyBytes) break;
      bodyBytes += size;
      batch.push({ held: h, count: h.unsent });
      if (batch.length >= limits.maxBatch) break;
    }
    if (batch.length === 0 && !hasDrops(drops)) return;
    for (const b of batch) b.held.unsent -= b.count;
    for (const [reason, n] of Object.entries(drops) as [
      PageDropReason,
      number,
    ][]) {
      const left = (unsentDrops[reason] ?? 0) - n;
      if (left > 0) unsentDrops[reason] = left;
      else delete unsentDrops[reason];
    }
    posts += 1;
    sending = true;
    let answer: SiteReportsResponse | null = null;
    try {
      answer = await deps.send(
        batch.map((b) => ({
          ...b.held.report,
          count: Math.min(b.count, SITE_REPORT_LIMITS.maxCount),
        })),
        drops,
        { keepalive: opts?.keepalive ?? false },
      );
    } catch (err) {
      // A failed report POST must not throw: as an unhandled rejection the
      // crash collector would report it through this very channel (a loop).
      // It is said on the console and backed off; the counts are kept.
      deps.warn(
        `[site-reports] batch not delivered: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      sending = false;
    }
    if (rerun !== null) {
      const again = rerun;
      rerun = null;
      if (again.keepalive) {
        // The page is going away: no timer will fire, send now.
        if (answer?.kind !== "accepted") {
          for (const b of batch) b.held.unsent += b.count;
          restoreDrops(drops);
        }
        await flush({ keepalive: true });
        return;
      }
    }
    if (answer?.kind === "accepted") {
      failures = 0;
      backoffMs = limits.batchDelayMs;
    } else {
      // Not delivered: the occurrences go back, to ride the next batch.
      for (const b of batch) b.held.unsent += b.count;
      restoreDrops(drops);
      if (answer?.kind === "rate-limited") {
        backoffMs = Math.min(answer.retryAfterS * 1000, limits.maxBackoffMs);
      } else {
        failures += 1;
        backoffMs = Math.min(backoffMs * 2, limits.maxBackoffMs);
        if (failures >= limits.maxFailures) {
          stopped = true;
          deps.warn(
            `[site-reports] ${failures} batches failed in a row — no more reports from this visit`,
          );
          return;
        }
      }
    }
    // More waiting (a burst past maxBatch, or a failure's counts): send later.
    const waiting =
      hasDrops(unsentDrops) || [...held.values()].some((h) => h.unsent > 0);
    if (waiting) {
      arm(answer?.kind === "accepted" ? limits.batchDelayMs : backoffMs);
    }
  }

  return {
    add,
    drop,
    flush,
    state: () => ({ distinct: held.size, posts, stopped, droppedLocally }),
  };
}
