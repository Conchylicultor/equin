// The stall watchdog's state machine — PURE: no timers, no ports, no storage.
// The SharedWorker feeds it events (a tab attached / answered a ping / posted
// its state or a long frame / went away, a clock tick, a filing ack, an
// orphaned record adopted) and carries out the effects it returns (ping the
// tabs, persist / forget a stored stall, hand a finished stall to a live tab to
// file, log a line). Everything the detector decides is decided here, so it is
// unit-tested without a browser (stall-machine.test.ts).
//
// Imports only this plugin's own worker-safe files (and types): the worker
// bundle must be self-contained.

import type { MainThreadStallPayload, StallFrame, StallTab } from "../../core";
import { STALL } from "./constants";

export interface PortState {
  readonly portId: string;
  tab: StallTab;
  /** Page Lifecycle `freeze` seen and no `resume` since. */
  frozen: boolean;
  /** Worker clock (epoch ms) of the last sign of life: pong, state, frame, attach. */
  lastPong: number;
  /** The last long frames (≥ FRAME_POST_MIN_MS), oldest first, capped at CRUMBS. */
  crumbs: StallFrame[];
  /** A suppressed (hidden / frozen) stale stretch was already logged. */
  suppressedLogged: boolean;
  /**
   * Its current silence was already accounted for as a cohort member of a
   * finished incident: it opens no incident of its own and files nothing
   * until it answers again.
   */
  covered: boolean;
}

interface Incident {
  readonly id: string;
  readonly primary: string;
  readonly primaryTab: StallTab;
  readonly crumbs: StallFrame[];
  readonly cohort: Map<string, StallTab>;
  startedAt: number;
  phase: "open" | "settling";
  endedAt: number | null;
  ended: "recovered" | "gone" | null;
  framesDuring: number;
  stallFrame: StallFrame | null;
  /** Worker clock of the last persist while open (null: never persisted). */
  persistedAt: number | null;
  /**
   * settling: the tab answered again; file at this instant. The wait lets the
   * tab's LoAF entry (the attribution) arrive, and tells a real recovery from a
   * hung tab whose reload/close made Chrome terminate its script: that tab
   * answers once, then goes — `gone` within the window.
   */
  fileAt: number | null;
}

/** A stored stall: an open one (payload says `unknown`, lower bound) or a finished one awaiting filing. */
export interface StallRecord {
  id: string;
  /** The watchdog that owns it; its lock free ⇒ the record is an orphan to adopt. */
  owner: string;
  payload: MainThreadStallPayload;
}

export type StallEffect =
  | { type: "ping"; portIds: string[] }
  | { type: "persist"; record: StallRecord }
  | { type: "forget"; id: string }
  | {
      type: "deliver";
      portId: string;
      id: string;
      payload: MainThreadStallPayload;
    }
  /** `portId`: a live (answering) tab to carry the line, null when there is none. */
  | { type: "log"; line: Record<string, unknown>; portId?: string | null };

export type StallEvent =
  | {
      type: "attach";
      portId: string;
      tab: StallTab;
      frozen: boolean;
      now: number;
    }
  | {
      type: "state";
      portId: string;
      tab: StallTab;
      frozen: boolean;
      now: number;
    }
  | { type: "pong"; portId: string; now: number }
  | { type: "frame"; portId: string; frame: StallFrame; now: number }
  /** The tab's port is gone: its liveness lock was granted to us, or it detached. */
  | { type: "gone"; portId: string; now: number }
  | { type: "tick"; now: number }
  /** The clock stopped (no visible tab, nothing in flight): the next tick is not "late". */
  | { type: "clock-stopped" }
  | { type: "filed"; id: string; ok: boolean }
  | { type: "adopt"; record: StallRecord };

export interface StallMachine {
  readonly workerId: string;
  readonly ports: Map<string, PortState>;
  readonly incidents: Map<string, Incident>;
  /** Finished stalls waiting for a live tab to file them. */
  readonly outbox: Map<
    string,
    { payload: MainThreadStallPayload; deliveredTo: string | null }
  >;
  lastTick: number | null;
  readonly newId: () => string;
}

export function createStallMachine(opts: {
  workerId: string;
  newId: () => string;
}): StallMachine {
  return {
    workerId: opts.workerId,
    ports: new Map(),
    incidents: new Map(),
    outbox: new Map(),
    lastTick: null,
    newId: opts.newId,
  };
}

/** Whether the worker needs its 1 Hz clock: a visible tab to watch, or a stall in flight. */
export function needsClock(m: StallMachine): boolean {
  if (m.incidents.size > 0) return true;
  for (const p of m.ports.values()) if (p.tab.visible && !p.frozen) return true;
  return false;
}

/** Feed one event; returns the effects to carry out, in order. Mutates `m`. */
export function step(m: StallMachine, ev: StallEvent): StallEffect[] {
  const out: StallEffect[] = [];
  switch (ev.type) {
    case "attach":
      m.ports.set(ev.portId, {
        portId: ev.portId,
        tab: ev.tab,
        frozen: ev.frozen,
        lastPong: ev.now,
        crumbs: [],
        suppressedLogged: false,
        covered: false,
      });
      break;
    case "state": {
      const p = m.ports.get(ev.portId);
      if (!p) break;
      const becameWatchable =
        (!p.tab.visible || p.frozen) && ev.tab.visible && !ev.frozen;
      p.tab = ev.tab;
      p.frozen = ev.frozen;
      // A tab coming back into view was throttled until now: its staleness so
      // far measures the browser, not a stall.
      if (becameWatchable) p.lastPong = ev.now;
      alive(m, p, ev.now, out);
      break;
    }
    case "pong": {
      const p = m.ports.get(ev.portId);
      if (p) alive(m, p, ev.now, out);
      break;
    }
    case "frame":
      onFrame(m, ev.portId, ev.frame, ev.now);
      break;
    case "gone":
      onGone(m, ev.portId, ev.now, out);
      break;
    case "tick":
      onTick(m, ev.now, out);
      break;
    case "clock-stopped":
      m.lastTick = null;
      break;
    case "filed": {
      if (!m.outbox.delete(ev.id)) break;
      if (ev.ok) out.push({ type: "forget", id: ev.id });
      else
        // Kept in storage: it is filed again when this watchdog's successor
        // adopts it. Not retried here — a failing backend must not be hammered.
        out.push({ type: "log", line: { kind: "file-failed", id: ev.id } });
      break;
    }
    case "adopt":
      m.outbox.set(ev.record.id, {
        payload: ev.record.payload,
        deliveredTo: null,
      });
      out.push({
        type: "persist",
        record: { ...ev.record, owner: m.workerId },
      });
      break;
  }
  deliver(m, out);
  // A log line rides a tab that is answering — never the frozen one, whose
  // queue may die with it.
  const carrier = liveTabs(m)[0]?.portId ?? null;
  for (const e of out) if (e.type === "log") e.portId = carrier;
  return out;
}

// --- events ------------------------------------------------------------------

function alive(
  m: StallMachine,
  p: PortState,
  now: number,
  out: StallEffect[],
): void {
  p.lastPong = now;
  p.suppressedLogged = false;
  p.covered = false;
  const inc = primaryIncident(m, p.portId);
  if (!inc || inc.phase !== "open") return;
  inc.endedAt = now;
  inc.ended = "recovered";
  // The pong measures an UPPER bound (the freeze began somewhere in the second
  // after the last pong): under the report bar it cannot be a reportable stall.
  if (now - inc.startedAt < STALL.REPORT_MIN_MS) {
    drop(m, inc, out, "under-report-bar");
    return;
  }
  inc.phase = "settling";
  inc.fileAt = now + STALL.FRAME_GRACE_MS;
}

function onFrame(
  m: StallMachine,
  portId: string,
  frame: StallFrame,
  now: number,
): void {
  const p = m.ports.get(portId);
  if (!p) return;
  const inc = primaryIncident(m, portId);
  if (inc && isStallFrame(inc, frame, now)) {
    // The browser's own record of the frozen frame: the definitive start,
    // duration and attribution. It may arrive before or after the pong.
    if (inc.phase === "open") {
      inc.ended = "recovered";
      inc.endedAt = now;
      inc.phase = "settling";
      inc.fileAt = now + STALL.FRAME_GRACE_MS;
    }
    inc.stallFrame = frame;
    p.lastPong = now;
    return;
  }
  if (inc && inc.phase === "open") inc.framesDuring += 1;
  // Any frame is a sign of life only once no stall is open on the tab (a
  // render storm still posts frames while it never answers a ping).
  if (!inc || inc.phase !== "open") p.lastPong = now;
  p.crumbs.push(frame);
  if (p.crumbs.length > STALL.CRUMBS) p.crumbs.shift();
}

function onGone(
  m: StallMachine,
  portId: string,
  now: number,
  out: StallEffect[],
): void {
  const inc = primaryIncident(m, portId);
  if (inc) {
    // Open: it never came back. Settling: it answered only to be torn down —
    // a reload or close of the hung tab, which Chrome unblocks by terminating
    // its script. Either way the user's way out was to leave the tab.
    if (inc.phase === "open") inc.endedAt = now;
    inc.ended = "gone";
    finalize(m, inc, out);
  }
  m.ports.delete(portId);
  for (const o of m.outbox.values())
    if (o.deliveredTo === portId) o.deliveredTo = null;
}

function onTick(m: StallMachine, now: number, out: StallEffect[]): void {
  const last = m.lastTick;
  m.lastTick = now;
  if (last !== null && now - last > STALL.PING_MS + STALL.SLEEP_LATE_MS) {
    // The worker's own clock stalled: the machine slept or the host froze.
    // Every tab looks stale for that reason alone — reset, file nothing.
    out.push({
      type: "log",
      line: { kind: "sleep", lateMs: now - last - STALL.PING_MS },
    });
    for (const inc of [...m.incidents.values()])
      if (inc.phase === "open") drop(m, inc, out, "sleep");
    for (const p of m.ports.values()) {
      p.lastPong = now;
      p.covered = false;
    }
  }
  if (m.ports.size > 0)
    out.push({ type: "ping", portIds: [...m.ports.keys()] });

  for (const inc of [...m.incidents.values()])
    if (inc.phase === "settling" && inc.fileAt !== null && now >= inc.fileAt)
      finalize(m, inc, out);

  openStalls(m, now, out);

  // Persist open stalls once they cross the report bar, then at each doubling
  // of their age: a handful of writes, and a lower bound within 2× if the
  // watchdog dies with the stall still open.
  for (const inc of m.incidents.values()) {
    if (inc.phase !== "open") continue;
    const age = now - inc.startedAt;
    if (age < STALL.REPORT_MIN_MS) continue;
    if (inc.persistedAt !== null && age < 2 * (inc.persistedAt - inc.startedAt))
      continue;
    inc.persistedAt = now;
    out.push({
      type: "persist",
      record: {
        id: inc.id,
        owner: m.workerId,
        payload: payloadOf(inc, "unknown", now, true),
      },
    });
  }
}

function openStalls(m: StallMachine, now: number, out: StallEffect[]): void {
  const stale: PortState[] = [];
  for (const p of m.ports.values())
    if (
      now - p.lastPong > STALL.OPEN_AFTER_MS &&
      !p.covered &&
      !incidentOf(m, p.portId)
    )
      stale.push(p);
  if (stale.length === 0) return;

  // A tab that froze with an open stall's tab (same renderer) joins it.
  const loose: PortState[] = [];
  for (const p of stale) {
    const host = [...m.incidents.values()].find(
      (i) =>
        i.phase === "open" &&
        Math.abs(p.lastPong - i.startedAt) <= STALL.COHORT_WINDOW_MS,
    );
    if (host) host.cohort.set(p.portId, { ...p.tab });
    else loose.push(p);
  }

  const watchable = loose.filter((p) => p.tab.visible && !p.frozen);
  for (const p of loose) {
    if (watchable.includes(p) || p.suppressedLogged) continue;
    // Hidden or frozen at onset: Chrome throttles / freezes background tabs, so
    // its silence is the browser's doing. Logged once, never reported.
    p.suppressedLogged = true;
    out.push({
      type: "log",
      line: {
        kind: "suppressed",
        reason: p.frozen ? "frozen" : "hidden",
        tabId: p.tab.tabId,
        staleMs: now - p.lastPong,
      },
    });
  }
  if (watchable.length === 0) return;

  // One incident for every tab that went quiet together; the focused visible
  // tab is the primary, then the one that went quiet first.
  const primary = [...watchable].sort(
    (a, b) =>
      Number(b.tab.focused) - Number(a.tab.focused) || a.lastPong - b.lastPong,
  )[0]!;
  const inc: Incident = {
    id: m.newId(),
    primary: primary.portId,
    primaryTab: { ...primary.tab },
    crumbs: [...primary.crumbs],
    cohort: new Map(),
    startedAt: primary.lastPong,
    phase: "open",
    endedAt: null,
    ended: null,
    framesDuring: 0,
    stallFrame: null,
    persistedAt: null,
    fileAt: null,
  };
  for (const p of loose)
    if (
      p !== primary &&
      Math.abs(p.lastPong - inc.startedAt) <= STALL.COHORT_WINDOW_MS
    )
      inc.cohort.set(p.portId, { ...p.tab });
  m.incidents.set(inc.id, inc);
  out.push({
    type: "log",
    line: {
      kind: "open",
      id: inc.id,
      tabId: inc.primaryTab.tabId,
      cohort: inc.cohort.size,
    },
  });
}

// --- incident lifecycle ------------------------------------------------------

function finalize(m: StallMachine, inc: Incident, out: StallEffect[]): void {
  const ended = inc.ended ?? "recovered";
  const frame = inc.stallFrame;
  if (frame) {
    inc.startedAt = frame.startedAt;
    inc.endedAt = frame.startedAt + frame.durationMs;
  }
  const endedAt = inc.endedAt ?? inc.startedAt;
  if (endedAt - inc.startedAt < STALL.REPORT_MIN_MS) {
    // Its LoAF entry (≥ SLOW_OP_MIN_MS) is the tab's own slow-op already.
    drop(m, inc, out, "under-report-bar");
    return;
  }
  const payload = payloadOf(inc, ended, endedAt, false);
  release(m, inc);
  m.outbox.set(inc.id, { payload, deliveredTo: null });
  out.push({
    type: "persist",
    record: { id: inc.id, owner: m.workerId, payload },
  });
  out.push({
    type: "log",
    line: {
      kind: "finished",
      id: inc.id,
      ended,
      durationMs: payload.durationMs,
    },
  });
}

function drop(
  m: StallMachine,
  inc: Incident,
  out: StallEffect[],
  reason: string,
): void {
  release(m, inc);
  if (inc.persistedAt !== null) out.push({ type: "forget", id: inc.id });
  out.push({
    type: "log",
    line: {
      kind: "near-miss",
      reason,
      id: inc.id,
      tabId: inc.primaryTab.tabId,
      durationMs: (inc.endedAt ?? inc.startedAt) - inc.startedAt,
    },
  });
}

function payloadOf(
  inc: Incident,
  ended: MainThreadStallPayload["ended"],
  endedAt: number,
  lowerBound: boolean,
): MainThreadStallPayload {
  return {
    ...inc.primaryTab,
    startedAt: inc.startedAt,
    endedAt,
    durationMs: endedAt - inc.startedAt,
    durationIsLowerBound: lowerBound,
    ended,
    detector: "worker",
    framesDuring: inc.framesDuring,
    stallFrame: inc.stallFrame,
    frames: inc.crumbs,
    cohort: [...inc.cohort.values()],
    topFunction: topFunction(inc.stallFrame),
  };
}

/** Hand every undelivered finished stall to a live tab — the stalled tab's own id first (it came back), then a visible one. */
function deliver(m: StallMachine, out: StallEffect[]): void {
  for (const [id, o] of m.outbox) {
    if (o.deliveredTo !== null) continue;
    const live = liveTabs(m);
    const target =
      live.find((p) => p.tab.tabId === o.payload.tabId) ??
      live.find((p) => p.tab.visible) ??
      live[0];
    if (!target) continue;
    o.deliveredTo = target.portId;
    out.push({
      type: "deliver",
      portId: target.portId,
      id,
      payload: o.payload,
    });
  }
}

// --- helpers -----------------------------------------------------------------

/** Tabs that answer: not inside an incident, not a covered cohort member. */
function liveTabs(m: StallMachine): PortState[] {
  return [...m.ports.values()].filter(
    (p) => !p.covered && !incidentOf(m, p.portId),
  );
}

/** End an incident: its cohort's silence is accounted for until each answers again. */
function release(m: StallMachine, inc: Incident): void {
  m.incidents.delete(inc.id);
  for (const portId of inc.cohort.keys()) {
    const p = m.ports.get(portId);
    if (p) p.covered = true;
  }
}

function primaryIncident(
  m: StallMachine,
  portId: string,
): Incident | undefined {
  for (const i of m.incidents.values()) if (i.primary === portId) return i;
  return undefined;
}

function incidentOf(m: StallMachine, portId: string): Incident | undefined {
  for (const i of m.incidents.values())
    if (i.primary === portId || i.cohort.has(portId)) return i;
  return undefined;
}

/** A frame at least OPEN_AFTER_MS long overlapping the stall window is the stall itself. */
function isStallFrame(inc: Incident, frame: StallFrame, now: number): boolean {
  if (frame.durationMs < STALL.OPEN_AFTER_MS) return false;
  const end = inc.endedAt ?? now;
  return (
    frame.startedAt < end &&
    frame.startedAt + frame.durationMs > inc.startedAt - STALL.PING_MS
  );
}

/** The frame's longest script as `function (invoker)`, or null when the browser attributed none. */
export function topFunction(frame: StallFrame | null): string | null {
  const top = frame?.scripts[0];
  if (!top) return null;
  const fn = top.sourceFunctionName || "(anonymous)";
  return top.invoker ? `${fn} (${top.invoker})` : fn;
}
