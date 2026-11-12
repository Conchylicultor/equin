import type { SleepNow } from "@plugins/infra/plugins/host/plugins/machine-sleep/core";
import { OP_KIND_IDS, type OpKind } from "@plugins/infra/plugins/worktree/core";
import type {
  LegacyOpenWait,
  OpEvent,
  OpFoldState,
  OpIdentity,
  OpLine,
  OpLiveTimes,
  OpRecord,
  OpSleep,
  OpSleepStamp,
  OpSummary,
  OpWait,
  OpWaitSpan,
  OpenWait,
  RawOpRecord,
  SleepStamp,
} from "./types";

// The reducer: append-only lines → one folded state per op → one read-model
// record. ONE reducer for every reader — the CLI's file reads (`await`, the
// build-lock waiter, the Gantt/stats endpoints) today, a DB ingester next — so
// "what state is this op in" has exactly one answer. Pure and `now`-injected, so
// the live synthesis is testable without a clock.
//
// Rules:
// - A terminal wins, and every line after it is ignored — duplicate reconciler
//   terminals are harmless.
// - A non-terminal v2 event applies only when `seq > lastSeq`, which makes
//   re-ingesting the same bytes idempotent.
// - A legacy snapshot line (a pre-v2 CLI) folds with the old snapshot
//   semantics: last `requested` stamp wins for identity and the open wait, and
//   between re-stamps and the `granted` snapshot the LONGER wait list wins
//   (wait lists only append, so the longer one is by construction the newer).
// - Sleep: every v2 event may carry the machine's sleep clock (`sleep`). Two
//   stamps of one boot differ by exactly the sleep between them, which folds
//   into `sleeps` on the WALL axis (see `advanceSleeps`). An event without a
//   stamp leaves the last one untouched; a new boot resets it and invents
//   nothing. The read model splits every op's span into waiting / working /
//   asleep in ONE helper (`breakdown`), so the three always add up.

const EPOCH = new Date(0).toISOString();

// A line's self-reported kind is untrusted input (another process, possibly an
// older CLI), so a kind outside the closed set must not be cast through to
// `OpRecord.kind` where the type would then be lying. Falls back to "build",
// mirroring `markerInfoFromParsed`'s identical guard in worktree-op.ts.
const KNOWN_KINDS: readonly OpKind[] = OP_KIND_IDS;

function coerceKind(raw: OpKind | undefined): OpKind {
  return raw !== undefined && KNOWN_KINDS.includes(raw) ? raw : "build";
}

/** Sum a wait list into the derived scalar the read model exposes as `waitMs`. */
export function sumWaits(waits: readonly OpWaitSpan[]): number {
  return waits.reduce((total, w) => total + w.durationMs, 0);
}

function parseMs(iso: string | null, fallbackMs: number): number {
  if (iso === null) return fallbackMs;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? fallbackMs : ms;
}

/** The state of an op no line has been applied to yet. */
export function emptyOpState(opId: string): OpFoldState {
  return {
    opId,
    identity: null,
    requestedAt: null,
    grantedAt: null,
    completedAt: null,
    waits: [],
    openWait: null,
    cycle: 0,
    lastSeq: 0,
    closedBy: null,
    outcome: null,
    interrupted: false,
    holdMs: 0,
    totalMs: 0,
    steps: [],
    sleeps: [],
    sleepStamp: null,
  };
}

/** Is this line a v2 event (vs a legacy snapshot)? */
export function isOpEvent(line: OpLine): line is OpEvent {
  return "e" in line;
}

/** Has this op written its terminal line? */
export function isTerminalState(state: OpFoldState): boolean {
  return state.closedBy !== null;
}

// ── sleep ───────────────────────────────────────────────────────────────────

/**
 * Below this, growth between two stamps is read jitter (the two raw clocks are
 * read one after the other), not a nap worth a block.
 */
const MIN_SLEEP_MS = 100;

/** Merge overlapping or touching sleeps; a merged block is `approx` if any part was. */
function mergeSleeps(sleeps: readonly OpSleep[]): OpSleep[] {
  const sorted = [...sleeps].sort((a, b) => a.startMs - b.startMs);
  const out: OpSleep[] = [];
  for (const sl of sorted) {
    const last = out.at(-1);
    if (last && sl.startMs <= last.startMs + last.durationMs) {
      const end = Math.max(
        last.startMs + last.durationMs,
        sl.startMs + sl.durationMs,
      );
      out[out.length - 1] = {
        startMs: last.startMs,
        durationMs: end - last.startMs,
        approx: last.approx || sl.approx,
      };
    } else {
      out.push(sl);
    }
  }
  return out;
}

/**
 * Fold one sleep stamp, taken at the wall instant `atMs` (epoch ms), into the
 * sleeps seen so far. THE one statement of the rule, shared by the reducer, the
 * writer's running fold (`createOpProfiler`), the reconciler's closing event and
 * the reader's live tail:
 *
 * - Same boot as `prev` and `asleepMs` grew by `delta`: the gap between the two
 *   stamps held `delta` of sleep. When the stamp's `wakeAtMs` falls inside the
 *   gap the block is `[wakeAtMs − delta, wakeAtMs]` (exact); otherwise it sits
 *   at the END of the gap (`approx`) — a wake is what usually unblocks the next
 *   event. Either way clamped to the gap (and `approx` if that clipped it).
 * - A different boot, or no `prev`: no interval, just the new stamp. Sleep is
 *   never invented across a reboot.
 * - `requestedMs` unknown (a headless op): no interval either — a block has no
 *   axis to sit on. Its terminal summary carries the writer's own.
 */
export function advanceSleeps(
  sleeps: readonly OpSleep[],
  prev: OpSleepStamp | null,
  stamp: SleepStamp,
  atMs: number,
  requestedMs: number | null,
): { sleeps: OpSleep[]; stamp: OpSleepStamp } {
  const next: OpSleepStamp = {
    boot: stamp.boot,
    asleepMs: stamp.asleepMs,
    atMs,
  };
  const delta = prev === null ? 0 : stamp.asleepMs - prev.asleepMs;
  if (
    prev === null ||
    prev.boot !== stamp.boot ||
    requestedMs === null ||
    delta < MIN_SLEEP_MS ||
    atMs <= prev.atMs
  ) {
    return { sleeps: [...sleeps], stamp: next };
  }
  const wake = stamp.wakeAtMs;
  const exact = wake !== undefined && wake > prev.atMs && wake <= atMs;
  const end = exact ? wake : atMs;
  const start = Math.max(prev.atMs, end - delta);
  const block: OpSleep = {
    startMs: start - requestedMs,
    durationMs: end - start,
    approx: !exact || end - start < delta,
  };
  return { sleeps: mergeSleeps([...sleeps, block]), stamp: next };
}

/** A reader's `sleepNow` as a stamp, for the live tail and the reconciler. */
function stampOf(now: NonNullable<SleepNow>): SleepStamp {
  return now.wakeAtMs === null
    ? { boot: now.boot, asleepMs: now.asleepMs }
    : { boot: now.boot, asleepMs: now.asleepMs, wakeAtMs: now.wakeAtMs };
}

/** Apply an event's stamp, if it carries one. */
function stampSleep(
  s: OpFoldState,
  stamp: SleepStamp | undefined,
  at: string,
): OpFoldState {
  if (stamp === undefined) return s; // legacy writer / unsupported: unknown
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return s;
  const requestedMs = s.requestedAt === null ? null : Date.parse(s.requestedAt);
  const { sleeps, stamp: sleepStamp } = advanceSleeps(
    s.sleeps,
    s.sleepStamp,
    stamp,
    atMs,
    requestedMs === null || Number.isNaN(requestedMs) ? null : requestedMs,
  );
  return { ...s, sleeps, sleepStamp };
}

/**
 * A closed wait's wall extent: from when it opened (`startedAt`) to the event
 * that closed it. `undefined` when the op has no `requestedAt` to offset from.
 */
function wallOf(
  s: OpFoldState,
  startMs: number,
  endMs: number,
): { atMs: number; wallMs: number } | undefined {
  if (s.requestedAt === null) return undefined;
  const requestedMs = Date.parse(s.requestedAt);
  if ([requestedMs, startMs, endMs].some(Number.isNaN)) return undefined;
  return { atMs: startMs - requestedMs, wallMs: Math.max(0, endMs - startMs) };
}

// ── v2 ──────────────────────────────────────────────────────────────────────

function applyV2(s: OpFoldState, ev: OpEvent): OpFoldState {
  if (ev.e === "completed") {
    const { summary } = ev;
    // The writer saw every event, so its sleeps are authoritative; an older
    // writer's summary has none, and the fold's own (closed by this event's
    // stamp) stand in.
    const stamped = stampSleep(
      { ...s, requestedAt: s.requestedAt ?? summary.requestedAt },
      ev.sleep,
      ev.at,
    );
    return {
      ...s,
      identity: {
        kind: coerceKind(summary.kind),
        opSlug: summary.opSlug,
        branch: summary.branch,
        conversationId: summary.conversationId,
        lane: summary.lane,
        mode: summary.mode,
        buildId: summary.buildId,
        pid: summary.pid,
        opportunistic: summary.opportunistic === true,
      },
      requestedAt: summary.requestedAt,
      grantedAt: summary.grantedAt,
      completedAt: summary.completedAt,
      waits: summary.waits,
      openWait: null,
      cycle: summary.waits.reduce((c, w) => Math.max(c, w.cycle), s.cycle),
      lastSeq: Math.max(s.lastSeq, ev.seq),
      closedBy: ev.by,
      outcome: summary.outcome,
      interrupted: summary.interrupted,
      holdMs: summary.holdMs,
      totalMs: summary.totalMs,
      steps: summary.steps,
      sleeps: summary.sleeps ? mergeSleeps(summary.sleeps) : stamped.sleeps,
      sleepStamp: stamped.sleepStamp,
    };
  }

  if (ev.seq <= s.lastSeq) return s; // already applied — re-ingest is a no-op
  return stampSleep(applyV2Change(s, ev), ev.sleep, ev.at);
}

function applyV2Change(
  s: OpFoldState,
  ev: Exclude<OpEvent, { e: "completed" }>,
): OpFoldState {
  const next: OpFoldState = { ...s, lastSeq: ev.seq };
  switch (ev.e) {
    case "requested":
      next.identity = {
        kind: coerceKind(ev.kind),
        opSlug: ev.opSlug,
        branch: ev.branch,
        conversationId: ev.conversationId,
        lane: ev.lane,
        mode: ev.mode,
        buildId: ev.buildId,
        pid: ev.pid,
        opportunistic: ev.opportunistic === true,
      };
      next.requestedAt = ev.at;
      return next;
    case "wait-start": {
      // The writer always closes a wait before opening the next; should one
      // still be open, close it here rather than lose the interval.
      if (s.openWait)
        next.waits = [
          ...s.waits,
          {
            ...abortedAt(s.openWait, ev.t),
            ...wallOf(s, Date.parse(s.openWait.startedAt), Date.parse(ev.at)),
          },
        ];
      next.openWait = {
        kind: ev.wait,
        startMs: ev.t,
        startedAt: ev.at,
        reason: ev.reason,
        cycle: ev.cycle,
      };
      return next;
    }
    case "wait-end": {
      // On the wall axis: from the open wait's `startedAt` to this event. A
      // fast-path grant's lone wait-end has no open wait — it ends here and
      // lasted `durationMs` (≈0 by construction, so the clocks cannot differ).
      const endMs = Date.parse(ev.at);
      const wall = wallOf(
        s,
        s.openWait ? Date.parse(s.openWait.startedAt) : endMs - ev.durationMs,
        endMs,
      );
      next.waits = [
        ...s.waits,
        {
          kind: ev.wait,
          startMs: ev.startMs,
          durationMs: ev.durationMs,
          reason: ev.reason,
          cycle: ev.cycle,
          result: ev.result,
          ...wall,
        },
      ];
      next.openWait = null;
      return next;
    }
    case "requeue":
      next.cycle = ev.cycle;
      return next;
    case "granted":
      next.grantedAt = ev.at;
      return next;
  }
}

function abortedAt(open: OpenWait, nowT: number): OpWait {
  return {
    kind: open.kind,
    startMs: open.startMs,
    durationMs: Math.max(0, nowT - open.startMs),
    reason: open.reason,
    cycle: open.cycle,
    result: "aborted",
  };
}

// ── legacy ──────────────────────────────────────────────────────────────────

function legacyWaits(waits: readonly OpWaitSpan[] | undefined): OpWait[] {
  return (waits ?? []).map((w) => ({
    kind: w.kind,
    startMs: w.startMs,
    durationMs: w.durationMs,
    reason: null,
    cycle: 0,
    result: null,
  }));
}

function legacyOpenWait(w: LegacyOpenWait | null | undefined): OpenWait | null {
  if (!w) return null;
  return {
    kind: w.kind,
    startMs: w.startMs,
    startedAt: w.startedAt,
    reason: null,
    cycle: 0,
  };
}

/**
 * Identity from a legacy line, falling back per field to what is already known.
 * Only a key the line genuinely carries (even as an explicit `null`) overrides —
 * a lean terminal that omits `lane` must not null out the `requested` line's.
 */
function legacyIdentity(r: RawOpRecord, known: OpIdentity | null): OpIdentity {
  return {
    kind: coerceKind(r.kind ?? known?.kind),
    opSlug: r.opSlug !== undefined ? r.opSlug : (known?.opSlug ?? null),
    branch: r.branch ?? known?.branch ?? r.opId,
    conversationId:
      r.conversationId !== undefined
        ? r.conversationId
        : (known?.conversationId ?? null),
    lane: r.lane !== undefined ? r.lane : (known?.lane ?? null),
    mode: r.mode !== undefined ? r.mode : (known?.mode ?? null),
    buildId: r.buildId !== undefined ? r.buildId : (known?.buildId ?? null),
    pid: known?.pid ?? null,
    // A legacy (pre-v2) writer predates opportunistic ops.
    opportunistic: false,
  };
}

/** The longer list wins — a wait list only appends, so it is the newer one. */
function longerWaits(current: OpWait[], candidate: OpWait[]): OpWait[] {
  return candidate.length >= current.length ? candidate : current;
}

function applyLegacy(s: OpFoldState, r: RawOpRecord): OpFoldState {
  switch (r.phase) {
    case "requested":
      // A re-stamp: the freshest identity and open wait win outright (the
      // latest `requested` line is the whole identity, as it always was).
      return {
        ...s,
        identity: legacyIdentity(r, null),
        requestedAt: r.requestedAt ?? s.requestedAt,
        waits: longerWaits(s.waits, legacyWaits(r.waits)),
        openWait: legacyOpenWait(r.openWait),
      };
    case "granted":
      return {
        ...s,
        // A granted line with no instant still flips the op to running,
        // clocked from its request, as the snapshot fold did.
        grantedAt: r.grantedAt ?? s.requestedAt ?? EPOCH,
        waits: longerWaits(s.waits, legacyWaits(r.waits)),
      };
    case "completed":
      return {
        ...s,
        identity: legacyIdentity(r, s.identity),
        requestedAt: r.requestedAt ?? s.requestedAt,
        grantedAt: r.grantedAt ?? r.requestedAt ?? null,
        completedAt: r.completedAt ?? null,
        // The terminal's OWN accumulated list — never the granted snapshot.
        waits: legacyWaits(r.waits),
        openWait: null,
        closedBy: r.interrupted === true ? "reconciler" : "self",
        outcome: r.outcome ?? "error",
        interrupted: r.interrupted ?? false,
        holdMs: r.holdMs ?? 0,
        totalMs: r.totalMs ?? 0,
        steps: r.steps ?? [],
      };
  }
}

// ── the reducer ─────────────────────────────────────────────────────────────

/**
 * Apply one line to one op's state. Pure: returns a new state (or the same one
 * when the line is ignored) and never mutates its input, so a store can load a
 * row, apply, compare and write back.
 */
export function applyOpEvent(
  state: OpFoldState | undefined,
  line: OpLine,
): OpFoldState {
  const s = state ?? emptyOpState(line.opId);
  if (isTerminalState(s)) return s; // the terminal wins; later lines are noise
  return isOpEvent(line) ? applyV2(s, line) : applyLegacy(s, line);
}

/**
 * Fold every line into one state per op. Grouping is by `opId`, never by
 * adjacency: the file is a shared append log, so ops' lines arrive interleaved.
 */
export function foldOpLines(lines: Iterable<OpLine>): Map<string, OpFoldState> {
  const byId = new Map<string, OpFoldState>();
  for (const line of lines)
    byId.set(line.opId, applyOpEvent(byId.get(line.opId), line));
  return byId;
}

// ── read model ──────────────────────────────────────────────────────────────

type Span = readonly [start: number, end: number];

/** Sorted, disjoint spans covering exactly the input, clipped to `[0, limit]`. */
function union(spans: readonly Span[], limit: number): Span[] {
  const clipped = spans
    .map(([a, b]): Span => [Math.max(0, a), Math.min(limit, b)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of clipped) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const length = (spans: readonly Span[]): number =>
  spans.reduce((t, [a, b]) => t + (b - a), 0);

/** Total overlap of two disjoint span sets. */
function overlap(xs: readonly Span[], ys: readonly Span[]): number {
  let total = 0;
  for (const [a, b] of xs)
    for (const [c, d] of ys)
      total += Math.max(0, Math.min(b, d) - Math.max(a, c));
  return total;
}

const sleepSpan = (sl: OpSleep): Span => [
  sl.startMs,
  sl.startMs + sl.durationMs,
];

/**
 * A wait on the wall axis: its wall fields when it has them, else (a legacy
 * line) its `t` offsets — on an op with no sleep stamps the two clocks agree.
 */
const waitSpan = (w: OpWait): Span =>
  w.atMs !== undefined && w.wallMs !== undefined
    ? [w.atMs, w.atMs + w.wallMs]
    : [w.startMs, w.startMs + w.durationMs];

interface Breakdown {
  waitingMs: number;
  workingMs: number;
  asleepMs: number;
}

/**
 * THE split of an op's `totalMs` — used by both `toOpRecord` and `liveTimes`,
 * so the identity `waiting + working + asleep === total` holds by construction:
 *
 * - asleep  = the union of the sleeps, inside the span;
 * - waiting = the union of the waits' wall extents, inside the span, minus
 *   their overlap with sleep — a nap during a queue is asleep, not waiting;
 * - working = the rest.
 */
function breakdown(
  totalMs: number,
  waits: readonly OpWait[],
  sleeps: readonly OpSleep[],
): Breakdown {
  const asleep = union(sleeps.map(sleepSpan), totalMs);
  const waiting = union(waits.map(waitSpan), totalMs);
  const asleepMs = length(asleep);
  const waitingMs = length(waiting) - overlap(waiting, asleep);
  return {
    waitingMs,
    asleepMs,
    workingMs: Math.max(0, totalMs - waitingMs - asleepMs),
  };
}

/** Sleeps clipped to the op's span, for display. */
function clipSleeps(sleeps: readonly OpSleep[], totalMs: number): OpSleep[] {
  const out: OpSleep[] = [];
  for (const sl of sleeps) {
    const start = Math.max(0, sl.startMs);
    const end = Math.min(totalMs, sl.startMs + sl.durationMs);
    if (end > start)
      out.push({ startMs: start, durationMs: end - start, approx: sl.approx });
  }
  return out;
}

/**
 * The in-flight sleeps: the folded ones plus the TAIL since the last stamp,
 * when the reader's `sleepNow` (same boot) shows the machine has slept since.
 * Derived on every read and never stored — the next event's stamp is what
 * records it.
 */
function liveSleeps(
  s: OpFoldState,
  requestedMs: number,
  now: number,
  sleepNow: SleepNow,
): OpSleep[] {
  if (sleepNow === null || s.sleepStamp === null) return s.sleeps;
  return advanceSleeps(
    s.sleeps,
    s.sleepStamp,
    stampOf(sleepNow),
    now,
    requestedMs,
  ).sleeps;
}

/**
 * The closed waits plus the open one, clocked against `now`: its wall extent
 * runs from `startedAt` to `now`, and its `durationMs` is that minus any sleep
 * inside it (as a closed wait's monotonic `t` duration excludes it too).
 */
function liveWaits(
  s: OpFoldState,
  requestedMs: number,
  now: number,
  sleeps: readonly OpSleep[],
): { waits: OpWait[]; openWaitMs: number } {
  if (!s.openWait) return { waits: s.waits, openWaitMs: 0 };
  const openedMs = parseMs(s.openWait.startedAt, requestedMs);
  const atMs = openedMs - requestedMs;
  const wallMs = Math.max(0, now - openedMs);
  const openWaitMs =
    wallMs -
    overlap([[atMs, atMs + wallMs]], union(sleeps.map(sleepSpan), Infinity));
  return {
    waits: [
      ...s.waits,
      {
        kind: s.openWait.kind,
        startMs: s.openWait.startMs,
        durationMs: openWaitMs,
        reason: s.openWait.reason,
        cycle: s.openWait.cycle,
        result: null,
        atMs,
        wallMs,
      },
    ],
    openWaitMs,
  };
}

/** Everything the read model derives from a state at `now`, in ONE place. */
function resolve(
  s: OpFoldState,
  now: number,
  sleepNow: SleepNow,
): {
  requestedMs: number;
  totalMs: number;
  waits: OpWait[];
  sleeps: OpSleep[];
  openWaitMs: number;
  times: Breakdown;
} {
  if (s.closedBy !== null) {
    const requestedMs = parseMs(s.requestedAt, 0);
    return {
      requestedMs,
      totalMs: s.totalMs,
      waits: s.waits,
      sleeps: clipSleeps(s.sleeps, s.totalMs),
      openWaitMs: 0,
      times: breakdown(s.totalMs, s.waits, s.sleeps),
    };
  }
  const requestedMs = parseMs(s.requestedAt, now);
  const totalMs = Math.max(0, now - requestedMs);
  const sleeps = liveSleeps(s, requestedMs, now, sleepNow);
  const { waits, openWaitMs } = liveWaits(s, requestedMs, now, sleeps);
  return {
    requestedMs,
    totalMs,
    waits,
    sleeps: clipSleeps(sleeps, totalMs),
    openWaitMs,
    times: breakdown(totalMs, waits, sleeps),
  };
}

/**
 * The read-model record for one op, or `null` for a headless in-flight op (its
 * `requested` line was never seen, so there is no identity to render).
 *
 * - Terminal ⇒ the writer's frozen numbers.
 * - Not yet granted ⇒ synthetic `"waiting"`, total growing against `now`.
 * - Granted ⇒ synthetic `"running"`, hold growing — and the wait list keeps
 *   growing too: `granted` means "stopped queuing for the ENTRY ticket", not
 *   "will never block again" (a build's duress-valve / host-grant waits come
 *   minutes after its build lock). It does not flip back to `"waiting"`.
 *
 * `now` and `sleepNow` (the machine's sleep clock now; `null` = unknown, so no
 * live tail) are INJECTED, never read inside.
 */
export function toOpRecord(
  s: OpFoldState,
  now: number,
  sleepNow: SleepNow,
): OpRecord | null {
  if (!s.identity) return null;
  const { pid, ...identity } = s.identity;
  const base = { opId: s.opId, ...identity, pid, cycle: s.cycle };
  const r = resolve(s, now, sleepNow);
  const derived = {
    waits: r.waits,
    waitMs: r.times.waitingMs,
    sleeps: r.sleeps,
    asleepMs: r.times.asleepMs,
  };

  if (s.closedBy !== null) {
    const requestedAt = s.requestedAt ?? EPOCH;
    return {
      ...base,
      ...derived,
      requestedAt,
      grantedAt: s.grantedAt ?? requestedAt,
      completedAt: s.completedAt,
      openWait: null,
      holdMs: s.holdMs,
      totalMs: s.totalMs,
      outcome: s.outcome ?? "error",
      interrupted: s.interrupted,
      closedBy: s.closedBy,
      steps: s.steps,
    };
  }

  const requestedAt = s.requestedAt ?? new Date(r.requestedMs).toISOString();
  const inFlight = {
    ...base,
    ...derived,
    requestedAt,
    completedAt: null,
    openWait: s.openWait,
    totalMs: r.totalMs,
    interrupted: false,
    closedBy: null,
    // Steps accumulate in-process and land only on the terminal; a live bar
    // claims none rather than a stale subset.
    steps: [],
  };
  if (s.grantedAt !== null) {
    const grantedMs = parseMs(s.grantedAt, r.requestedMs);
    return {
      ...inFlight,
      grantedAt: s.grantedAt,
      holdMs: Math.max(0, now - grantedMs),
      outcome: "running",
    };
  }
  // No grant yet — no hold to clock.
  return { ...inFlight, grantedAt: requestedAt, holdMs: 0, outcome: "waiting" };
}

/** Every renderable op in a fold, as read-model records. */
export function toOpRecords(
  states: Iterable<OpFoldState>,
  now: number,
  sleepNow: SleepNow,
): OpRecord[] {
  const out: OpRecord[] = [];
  for (const s of states) {
    const rec = toOpRecord(s, now, sleepNow);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Waited vs worked vs asleep at `now` — the ONLY place these are computed, for
 * every surface, through the same `breakdown` as `toOpRecord`. Durations are
 * clamped at 0 (the writer's and the reader's clocks can disagree).
 */
export function liveTimes(
  s: OpFoldState,
  now: number,
  sleepNow: SleepNow,
): OpLiveTimes {
  const r = resolve(s, now, sleepNow);
  return {
    elapsedMs: r.totalMs,
    ...r.times,
    openWaitMs: r.openWaitMs,
  };
}

// ── reconciliation ──────────────────────────────────────────────────────────

/**
 * The in-flight ops with an identity — the orphan reconciler's candidate set.
 * A headless op (no `requested` seen) is never a candidate: finalizing it from a
 * partial view would stamp an invented terminal.
 */
export function orphanedOps(
  states: Iterable<OpFoldState>,
): (OpFoldState & { identity: OpIdentity })[] {
  const out: (OpFoldState & { identity: OpIdentity })[] = [];
  for (const s of states) {
    if (isTerminalState(s)) continue;
    const { identity } = s;
    if (identity) out.push({ ...s, identity });
  }
  return out;
}

/**
 * The terminal a reconciler appends for an op that died without writing one:
 * interrupted, `outcome: "error"`, no duration (it has no real end), the closed
 * waits kept and an open wait dropped rather than clocked to an invented end.
 * `seq` continues the op's own sequence.
 */
export function reconcilerCompletedEvent(
  s: OpFoldState & { identity: OpIdentity },
  now: number,
  sleepNow: SleepNow,
): OpEvent {
  const requestedAt = s.requestedAt ?? new Date(now).toISOString();
  // A dead op parked in a wait is the case history most needs to show (what it
  // was stuck on, why, which requeue cycle), so the open wait is kept, closed
  // as `aborted`. Its true end is unknown: it is clocked to when the
  // reconciler noticed, an upper bound (one reconcile tick late, or longer
  // while main was down).
  const requestedMs = parseMs(s.requestedAt, now);
  const nowT = Math.max(0, now - requestedMs);
  const waits: OpWait[] =
    s.openWait === null
      ? s.waits
      : [
          ...s.waits,
          {
            ...abortedAt(s.openWait, nowT),
            ...wallOf(s, Date.parse(s.openWait.startedAt), now),
          },
        ];
  // The reconciler's own reading closes the sleep tail: a killed laptop op's
  // last nap is still on record.
  const sleep = sleepNow === null ? undefined : stampOf(sleepNow);
  const sleeps =
    sleep === undefined
      ? s.sleeps
      : advanceSleeps(s.sleeps, s.sleepStamp, sleep, now, requestedMs).sleeps;
  const summary: OpSummary = {
    ...s.identity,
    requestedAt,
    grantedAt: s.grantedAt,
    completedAt: null,
    waits,
    holdMs: 0,
    totalMs: 0,
    outcome: "error",
    interrupted: true,
    steps: [],
    sleeps,
  };
  return {
    v: 2,
    opId: s.opId,
    seq: s.lastSeq + 1,
    at: new Date(now).toISOString(),
    t: nowT,
    ...(sleep === undefined ? {} : { sleep }),
    e: "completed",
    by: "reconciler",
    summary,
  };
}
