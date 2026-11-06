import {
  HOLD_CLASSES,
  HOLD_SPECS,
  deadlineMsFor,
  pickupTargetMsFor,
  type HoldClass,
} from "@plugins/infra/plugins/jobs/core";

// THE VERDICT of the health report's Job queue row: one pure function from the
// queue's facts to a colour, a one-line summary, and the next instant any of it
// could change on its own.
//
// Pure on purpose. The server runs it on every pulse load, so the colour, the
// timer that re-evaluates a silent queue, and any future agent read cannot
// disagree about what "the queue needs a look" means. Every line it draws is
// derived from the jobs class table (`pickupTargetMsFor`, `deadlineMsFor`) or
// from this plugin's config — nothing here restates a duration.
//
// Design: research/2026-09-11-global-job-queue-health-row.md, "The verdict".

/** A class's (or the row's) colour. `ok` is green; the other two are the dot's. */
export const QUEUE_TONES = ["ok", "attention", "critical"] as const;
export type QueueTone = (typeof QUEUE_TONES)[number];

/**
 * How far past its own pickup target a waiting job must be before the row turns
 * amber. A multiple of the target rather than a duration, so each class's line
 * scales with what that class promises: 10 s / 100 s / 10 min.
 */
export const ATTENTION_WAIT_MULTIPLE = 10;

/** Waiting this long for a slot turns the row amber. */
export function attentionWaitMs(hold: HoldClass): number {
  return ATTENTION_WAIT_MULTIPLE * pickupTargetMsFor(hold);
}

/**
 * Waiting this long for a slot turns the row red: the class's own deadline. A
 * job that has waited as long as one run of its class is allowed to HOLD a
 * slot is past anything the ladder was built to give it.
 */
export function criticalWaitMs(hold: HoldClass): number {
  return deadlineMsFor(hold);
}

/**
 * Holding a slot this long makes a running job "stuck". The same line the
 * `queue-slot-hog` report files at, so the dot and the bell agree.
 */
export function stuckHoldMs(hold: HoldClass, fraction: number): number {
  return fraction * deadlineMsFor(hold);
}

/** The colour one waiting job alone would give the row. */
export function waitTone(
  hold: HoldClass,
  runAt: number,
  now: number,
): QueueTone {
  const age = now - runAt;
  if (age >= criticalWaitMs(hold)) return "critical";
  if (age >= attentionWaitMs(hold)) return "attention";
  return "ok";
}

/** Whether a running job has held its slot past the stuck line. A forfeited
 * (written-off) slot is the extreme case and is always stuck. */
export function isStuck(
  row: { hold: HoldClass; lockedAt: number; forfeited: boolean },
  fraction: number,
  now: number,
): boolean {
  return row.forfeited || now - row.lockedAt >= stuckHoldMs(row.hold, fraction);
}

/** Whether a death still colours the row. `minutes = 0` disables the rule. */
export function isRecentDeath(
  lastDiedAt: number,
  minutes: number,
  now: number,
): boolean {
  return minutes > 0 && now - lastDiedAt < minutes * 60_000;
}

/**
 * A threshold as its exact whole units: `10s`, `1m 40s`, `10m`, `1h`. For the
 * lines this file draws, which are exact multiples of a class's numbers — not
 * for measured durations, which have no reason to be round.
 */
export function formatThresholdMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h > 0 && `${h}h`, m > 0 && `${m}m`, s > 0 && `${s}s`]
    .filter((part): part is string => part !== false)
    .join(" ");
}

/** What the verdict reads. Timestamps are epoch ms on the database's clock. */
export interface QueueFacts {
  /** One entry per class. */
  classes: ReadonlyArray<{
    hold: HoldClass;
    /** Slots on the runners that serve this class that are holding a job. */
    busy: number;
    /** Slots this class can ever reach. */
    reachable: number;
    /** Rows waiting for a slot (serial-lane rows excluded). */
    waiting: number;
    /** `run_at` of the oldest of them; `null` when none wait. */
    oldestWaitingRunAt: number | null;
    /** The next future `run_at` of an unlocked row; `null` if none. */
    nextDueAt: number | null;
  }>;
  /** Every slot holding a job in this backend. */
  running: ReadonlyArray<{
    jobName: string;
    hold: HoldClass;
    lockedAt: number;
    forfeited: boolean;
  }>;
  /** The listed waiting rows (the pulse's `oldestWaiting`). They move no
   * colour of their own — the class's oldest does — but each one's threshold
   * crossing changes how the detail marks it. */
  waiting: ReadonlyArray<{ hold: HoldClass; runAt: number }>;
  /** Deaths grouped by job name, most recent first. */
  dead: ReadonlyArray<{ jobName: string; count: number; lastDiedAt: number }>;
}

/** The two config fields the verdict reads. The full config satisfies it. */
export interface QueueVerdictConfig {
  slotHogDeadlineFraction: number;
  deadJobAttentionMinutes: number;
}

export interface QueueVerdict {
  state: QueueTone;
  summary: string;
  /** Per class: the colour that class contributed. A bar tints when not `ok`. */
  cause: Record<HoldClass, QueueTone>;
}

export interface QueueVerdictResult {
  verdict: QueueVerdict;
  /**
   * The earliest future instant at which re-running this function on the same
   * facts could give a different answer; `null` when nothing is pending. The
   * server arms one timer at it, so a wedged queue — which emits no events at
   * all — still turns amber on time.
   */
  nextChangeAt: number | null;
}

// Worst first within a tone: a queue that is starving now outranks one that
// has a stuck job, which outranks one that has already lost a job.
type CauseKind = "waiting" | "stuck" | "dead";
const KIND_RANK: Record<CauseKind, number> = { waiting: 0, stuck: 1, dead: 2 };
const TONE_RANK: Record<QueueTone, number> = {
  critical: 0,
  attention: 1,
  ok: 2,
};

interface Cause {
  tone: Exclude<QueueTone, "ok">;
  kind: CauseKind;
  /** Tie-break within a kind, higher first. */
  severity: number;
  text: string;
}

/** Most causes a summary names. The detail lists every job behind them. */
const SUMMARY_CAUSES = 2;

export function queueVerdict(
  facts: QueueFacts,
  cfg: QueueVerdictConfig,
  now: number,
): QueueVerdictResult {
  const causes: Cause[] = [];
  const cause = Object.fromEntries(
    HOLD_CLASSES.map((hold) => [hold, "ok"]),
  ) as Record<HoldClass, QueueTone>;
  const raise = (hold: HoldClass, tone: QueueTone): void => {
    if (TONE_RANK[tone] < TONE_RANK[cause[hold]]) cause[hold] = tone;
  };

  let nextChangeAt: number | null = null;
  const changeAt = (at: number | null): void => {
    if (at === null || at <= now) return;
    if (nextChangeAt === null || at < nextChangeAt) nextChangeAt = at;
  };
  const nextWaitLine = (hold: HoldClass, runAt: number): number | null => {
    for (const line of [attentionWaitMs(hold), criticalWaitMs(hold)]) {
      if (runAt + line > now) return runAt + line;
    }
    return null;
  };

  // 1. Waiting for a slot. Judged on each class's OLDEST waiting row — the
  // head of the class, the one that has waited longest.
  for (const c of facts.classes) {
    if (c.waiting === 0 || c.oldestWaitingRunAt === null) continue;
    const runAt = c.oldestWaitingRunAt;
    changeAt(nextWaitLine(c.hold, runAt));
    const tone = waitTone(c.hold, runAt, now);
    if (tone === "ok") continue;
    raise(c.hold, tone);
    const crossed =
      tone === "critical" ? criticalWaitMs(c.hold) : attentionWaitMs(c.hold);
    causes.push({
      tone,
      kind: "waiting",
      severity: (now - runAt) / pickupTargetMsFor(c.hold),
      text: waitingText(c, crossed),
    });
  }
  for (const w of facts.waiting) changeAt(nextWaitLine(w.hold, w.runAt));

  // 2. Stuck: a running job holding its slot past the slot-hog line.
  const fraction = cfg.slotHogDeadlineFraction;
  const stuck = facts.running.filter((r) => isStuck(r, fraction, now));
  for (const r of facts.running) {
    if (!r.forfeited) changeAt(r.lockedAt + stuckHoldMs(r.hold, fraction));
  }
  if (stuck.length > 0) {
    for (const r of stuck) raise(r.hold, "attention");
    causes.push({
      tone: "attention",
      kind: "stuck",
      severity: stuck.length,
      text: stuckText(stuck, fraction),
    });
  }

  // 3. Dead: a job died within the attention window. Classless — a dead row
  // holds no slot, so no bar tints for it.
  const recent = facts.dead.filter((d) =>
    isRecentDeath(d.lastDiedAt, cfg.deadJobAttentionMinutes, now),
  );
  for (const d of recent) {
    changeAt(d.lastDiedAt + cfg.deadJobAttentionMinutes * 60_000);
  }
  if (recent.length > 0) {
    causes.push({
      tone: "attention",
      kind: "dead",
      severity: recent.length,
      text: deadText(recent),
    });
  }

  // 4. A scheduled row becoming due while its class has no free slot. No event
  // marks that moment (nothing starts, nothing is inserted), so it needs the
  // timer like a threshold does. With a free slot, the pickup itself is the
  // event.
  for (const c of facts.classes) {
    if (c.busy >= c.reachable) changeAt(c.nextDueAt);
  }

  causes.sort(
    (a, b) =>
      TONE_RANK[a.tone] - TONE_RANK[b.tone] ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      b.severity - a.severity,
  );
  const worst = causes[0];
  return {
    verdict: {
      state: worst ? worst.tone : "ok",
      summary: worst
        ? causes
            .slice(0, SUMMARY_CAUSES)
            .map((c) => c.text)
            .join(" · ")
        : OK_SUMMARY,
      cause,
    },
    nextChangeAt,
  };
}

// Ages are phrased by the THRESHOLD crossed ("10m+"), never as a live count:
// the summary is recomputed on pushes and at threshold crossings, not every
// second, and "10m+" stays true between them where "11m" would not.

function waitingText(
  c: QueueFacts["classes"][number],
  threshold: number,
): string {
  const label = HOLD_SPECS[c.hold].label;
  const age = `${formatThresholdMs(threshold)}+`;
  // Only the oldest row's age is known, so a count above one says "oldest".
  const jobs =
    c.waiting === 1
      ? `1 job waiting ${age}`
      : `${c.waiting} jobs waiting, oldest ${age}`;
  return c.busy >= c.reachable
    ? `${label} class full · ${jobs}`
    : `${label}: ${jobs}`;
}

function stuckText(
  stuck: ReadonlyArray<QueueFacts["running"][number]>,
  fraction: number,
): string {
  const only = stuck.length === 1 ? stuck[0] : undefined;
  if (!only) return `${stuck.length} jobs stuck`;
  return only.forfeited
    ? `${only.jobName} stuck · written off`
    : `${only.jobName} stuck ${formatThresholdMs(stuckHoldMs(only.hold, fraction))}+`;
}

function deadText(recent: ReadonlyArray<QueueFacts["dead"][number]>): string {
  const only = recent.length === 1 ? recent[0] : undefined;
  if (!only) return `${recent.length} jobs failed`;
  return only.count > 1
    ? `${only.jobName} failed ×${only.count}`
    : `${only.jobName} failed`;
}

// The green summary is one fixed phrase, never a count. The verdict is every
// tab's always-on read, pushed only when it changes: "3 running · 2 waiting"
// moved on nearly every job start and finish, so a busy green queue still sent
// every tab a frame a second. Green says what the colour means — nothing
// waiting past its line, nothing stuck, no recent death — and the live counts
// are the open report's (the glance's bars, the detail's running list and
// "+ N waiting"), read from the pulse only it subscribes to.
export const OK_SUMMARY = "Keeping up";
