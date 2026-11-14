/**
 * The restart-storm benchmark: what one hot restart of a backend costs the
 * tabs that have it open — the cold start of the successor while every open
 * tab resubscribes at once, as main does on every push. Plan and findings:
 * the "Main restart storm" track page, and `../CLAUDE.md`.
 *
 *   ./equin run plugins/debug/plugins/profiling/plugins/restart-storm/e2e/restart-storm.ts \
 *     [--handoff off|on] [--iterations 3] [--paths /agents,/pages,…] [--contexts 1] \
 *     [--settle 8000] [--timeout 180000] [--out "$EQUIN_SCRATCH/storm.json"]
 *
 * Per iteration: every tab is open and settled; `POST /gateway/worktrees/<ns>/
 * restart` (the deploy's own hot restart: the successor boots beside the old
 * backend, is swapped in once ready, the old one drained and stopped — its
 * sockets close then, and every tab reconnects to the successor and replays
 * its whole sub set). Then, per tab, until every entry of its replay batch is
 * answered; then the successor's boot profile (phases, warm-ups, process CPU
 * at each phase boundary and now) and runtime profile (every loader's wall
 * split into gate waits and own work, the gates' totals). Each iteration
 * waits for the successor's `settled` span before the next restart.
 *
 * `--handoff off` (default — the headline) turns the epoch handoff off for
 * the run (live-state-snapshot's `live-state-handoff` config, reverted when the
 * run ends): the successor inherits nothing, so every replayed sub loads.
 * `--handoff on` is a DIAGNOSTIC: what the handoff hides.
 *
 * Own worktree only: it restarts the backend it targets, so never point it at
 * main (`--url`).
 */

import {
  agentFetch,
  arg,
  boot,
  numArg,
  pathUrl,
  report,
  targetNamespace,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import type { SocketTap } from "@plugins/primitives/plugins/networking/e2e";
import { ProfilingDataSchema } from "@plugins/debug/plugins/profiling/plugins/boot/core";
import type { ProfilingData } from "@plugins/debug/plugins/profiling/plugins/boot/core";
import {
  FLIGHT_WINDOW_COMPLETED_MAX,
  flightWindowResponseSchema,
  runtimeProfileSchema,
} from "@plugins/debug/plugins/profiling/plugins/runtime/core";
import type { Page } from "playwright";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import type { z } from "zod";

type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
type FlightWindow = z.infer<typeof flightWindowResponseSchema>;

const WS = "/ws/notifications";
const HANDOFF = arg("handoff", "off");
const ITERATIONS = numArg("iterations", 3);
const PATHS = arg(
  "paths",
  "/agents,/pages,/home,/prototypes,/studio,/debug,/deploy,/settings",
).split(",");
const CONTEXTS = numArg("contexts", 1);
const SETTLE_MS = numArg("settle", 8000);
const TIMEOUT_MS = numArg("timeout", 180_000);
const OUT = arg("out", "");
const HANDOFF_STORE =
  "network/live/live-state-snapshot/live-state-handoff.jsonc";

if (HANDOFF !== "on" && HANDOFF !== "off")
  throw new Error(`--handoff must be on or off, got ${HANDOFF}`);

const namespace = targetNamespace();
const r = report(
  `debug/profiling · restart storm (${namespace}, handoff ${HANDOFF}${HANDOFF === "on" ? " — DIAGNOSTIC" : " — cold"})`,
);

// ── Tabs ─────────────────────────────────────────────────────────────────────

type AnswerKind = "subAck" | "upToDate" | "error";

interface Tab {
  label: string;
  page: Page;
  tap: SocketTap;
  /** Every status / tx / rx of the worktree socket, stamped. */
  log: Array<{
    at: number;
    kind: string;
    status?: string;
    conn?: string | null;
    data?: string;
  }>;
}

function watchTab(label: string, page: Page, tap: SocketTap): Tab {
  const tab: Tab = { label, page, tap, log: [] };
  tap.onEvent((e, at) => {
    if (e.url !== WS) return;
    if (e.kind === "status")
      tab.log.push({ at, kind: "status", status: e.status, conn: e.conn });
    else tab.log.push({ at, kind: e.kind, data: e.data });
  });
  return tab;
}

interface TabRun {
  label: string;
  /** Epoch ms; null when not reached. */
  closedAt: number | null;
  openAt: number | null;
  replayAt: number | null;
  settledAt: number | null;
  entries: number;
  answers: Record<AnswerKind, number>;
  /** Per replayed entry: key and replay → answer ms. */
  perEntry: Array<{ key: string; ms: number; kind: AnswerKind }>;
}

/** The tab's replay on the first connection after `from`, and how it was answered. */
function readTabRun(
  tab: Tab,
  from: number,
  connBefore: string | undefined,
): TabRun {
  const run: TabRun = {
    label: tab.label,
    closedAt: null,
    openAt: null,
    replayAt: null,
    settledAt: null,
    entries: 0,
    answers: { subAck: 0, upToDate: 0, error: 0 },
    perEntry: [],
  };
  const sent = new Map<number, { key: string; at: number }>();
  const answered = new Map<number, { at: number; kind: AnswerKind }>();
  let conn: string | null = null;
  for (const ev of tab.log) {
    if (ev.at < from) continue;
    if (ev.kind === "status") {
      if (run.closedAt === null && ev.status !== "open") run.closedAt = ev.at;
      if (
        conn === null &&
        ev.status === "open" &&
        ev.conn != null &&
        ev.conn !== connBefore
      ) {
        conn = ev.conn;
        run.openAt = ev.at;
      }
      continue;
    }
    if (conn === null || ev.data === undefined) continue;
    const msg = JSON.parse(ev.data) as {
      op?: string;
      kind?: string;
      id?: number;
      entries?: Array<{ id?: number; key?: string }>;
    };
    if (ev.kind === "tx") {
      if (msg.op !== "sub-batch") continue;
      run.replayAt ??= ev.at;
      for (const e of msg.entries ?? [])
        if (typeof e.id === "number")
          sent.set(e.id, { key: e.key ?? "?", at: ev.at });
      continue;
    }
    const mark = (id: number | undefined, kind: AnswerKind) => {
      if (typeof id === "number" && !answered.has(id))
        answered.set(id, { at: ev.at, kind });
    };
    if (msg.kind === "sub-ack") mark(msg.id, "subAck");
    else if (msg.kind === "up-to-date") mark(msg.id, "upToDate");
    else if (msg.kind === "sub-error") mark(msg.id, "error");
    else if (msg.kind === "up-to-date-batch")
      for (const e of msg.entries ?? []) mark(e.id, "upToDate");
  }
  run.entries = sent.size;
  let last = 0;
  let all = sent.size > 0;
  for (const [id, s] of sent) {
    const a = answered.get(id);
    if (!a) {
      all = false;
      continue;
    }
    run.answers[a.kind]++;
    run.perEntry.push({ key: s.key, ms: a.at - s.at, kind: a.kind });
    last = Math.max(last, a.at);
  }
  if (all) run.settledAt = last;
  return run;
}

// ── Server reads ────────────────────────────────────────────────────────────

async function setHandoff(enabled: boolean): Promise<void> {
  const res = await agentFetch("/api/config-v2/set-field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      storePath: HANDOFF_STORE,
      key: "enabled",
      value: enabled,
    }),
  });
  if (!res.ok)
    throw new Error(
      `set-field ${HANDOFF_STORE} → ${res.status}: ${await res.text()}`,
    );
}

async function restart(): Promise<void> {
  const res = await agentFetch(
    `/gateway/worktrees/${encodeURIComponent(namespace)}/restart`,
    { method: "POST" },
  );
  if (!res.ok)
    throw new Error(
      `POST /gateway/worktrees/${namespace}/restart → ${res.status}: ${(await res.text()).trim()}`,
    );
}

async function bootProfile(): Promise<ProfilingData> {
  const res = await agentFetch("/api/debug/profiling/boot");
  if (!res.ok) throw new Error(`GET /api/debug/profiling/boot → ${res.status}`);
  return ProfilingDataSchema.parse(await res.json());
}

async function runtimeProfile(): Promise<RuntimeProfile> {
  const res = await agentFetch("/api/debug/profiling/runtime");
  if (!res.ok)
    throw new Error(`GET /api/debug/profiling/runtime → ${res.status}`);
  return runtimeProfileSchema.parse(await res.json());
}

/** The successor's recent spans (in flight and completed), the last `windowMs`. */
async function flightWindow(windowMs: number): Promise<FlightWindow> {
  const ms = Math.min(120_000, Math.max(1_000, Math.ceil(windowMs)));
  const res = await agentFetch(
    `/api/debug/profiling/flight-window?windowMs=${ms}&maxCompleted=${FLIGHT_WINDOW_COMPLETED_MAX}`,
  );
  if (!res.ok)
    throw new Error(`GET /api/debug/profiling/flight-window → ${res.status}`);
  return flightWindowResponseSchema.parse(await res.json());
}

/**
 * The replay's read path on the server, per key: every `sub` origin span (a
 * replayed sub's read — the flight it started or joined; ≥ 5 ms, the ring's
 * floor) that started after the first socket closed, with its wall split into
 * gate waits by layer, child work (the loader) and own work, and where it sat
 * on the wall clock: from the replay leaving the tab to the span's start (the
 * frame's transit plus everything the server's thread ran before handling it)
 * and from the span's end to the answer reaching the tab (the send and the
 * thread's backlog after the read).
 */
interface SubSplit {
  key: string;
  n: number;
  wallMax: number;
  wallSum: number;
  selfSum: number;
  childSum: number;
  waits: Record<string, number>;
  /** Replay sent (earliest tab) → span start, ms: mean and max. */
  startDelaySum: number;
  startDelayMax: number;
}

function splitSubs(
  fw: FlightWindow,
  from: number,
  replayAt: number,
): SubSplit[] {
  const toWall = (t: number) =>
    Date.parse(fw.wallAnchor.wallTime) + (t - fw.wallAnchor.atMs);
  const by = new Map<string, SubSplit>();
  for (const s of fw.window.completed) {
    if (s.kind !== "sub" || s.t1 === null) continue;
    const t0 = toWall(s.t0);
    if (t0 < from) continue;
    const k =
      by.get(s.label) ??
      ({
        key: s.label,
        n: 0,
        wallMax: 0,
        wallSum: 0,
        selfSum: 0,
        childSum: 0,
        waits: {},
        startDelaySum: 0,
        startDelayMax: 0,
      } satisfies SubSplit);
    const wall = s.t1 - s.t0;
    k.n++;
    k.wallMax = Math.max(k.wallMax, wall);
    k.wallSum += wall;
    k.selfSum += s.selfMs;
    k.childSum += s.childMs;
    for (const [layer, ms] of Object.entries(s.waits ?? {}))
      k.waits[layer] = (k.waits[layer] ?? 0) + ms;
    const delay = t0 - replayAt;
    k.startDelaySum += delay;
    k.startDelayMax = Math.max(k.startDelayMax, delay);
    by.set(s.label, k);
  }
  return [...by.values()];
}

/**
 * The event-loop stalls the successor's loop probe registered between the
 * replay leaving the first tab and the last tab settling, as wall offsets
 * from the replay: how long its thread ran one piece of work while every
 * replayed read waited to be handled or answered.
 */
function stallsDuring(
  fw: FlightWindow,
  from: number,
  to: number,
): { coveredMs: number; stalls: Array<{ at: number; ms: number }> } {
  const toWall = (t: number) =>
    Date.parse(fw.wallAnchor.wallTime) + (t - fw.wallAnchor.atMs);
  const stalls: Array<{ at: number; ms: number }> = [];
  let coveredMs = 0;
  for (const s of fw.loopStalls) {
    const t0 = Math.max(toWall(s.t0), from);
    const t1 = Math.min(toWall(s.t1), to);
    if (t1 <= t0) continue;
    coveredMs += t1 - t0;
    stalls.push({ at: Math.round(t0 - from), ms: Math.round(t1 - t0) });
  }
  return { coveredMs, stalls };
}

/** Waits until the serving process is a new one and its settled phase ended. */
async function awaitSettledBoot(
  notStartedBefore: number,
): Promise<ProfilingData> {
  const got = await waitFor(
    async () => {
      const p = await bootProfile();
      return p;
    },
    (p) =>
      p.processStartedAt >= notStartedBefore &&
      p.spans.some((s) => s.phase === "settled" && s.id === "settled"),
    { timeoutMs: TIMEOUT_MS, intervalMs: 1000 },
  );
  if (!got.ok) throw new Error("the successor never reached its settled phase");
  return got.value;
}

// ── Printing ─────────────────────────────────────────────────────────────────

const fmt = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? "—" : `${Math.round(ms)}`;

interface IterationResult {
  iteration: number;
  t0: number;
  marks: Record<string, number | null>;
  tabs: TabRun[];
  cpu: Record<string, number | null>;
  boot: ProfilingData;
  runtime: RuntimeProfile;
  subs: SubSplit[];
  loop: { coveredMs: number; stalls: Array<{ at: number; ms: number }> };
  /** The raw flight window read right after the tabs settled (for `--out`). */
  flight: FlightWindow;
  loadavg: number[];
}

function printIteration(it: IterationResult): void {
  const rel = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : `+${Math.round(v - it.t0)}`;
  r.note(
    `── iteration ${it.iteration} (load avg ${it.loadavg.map((x) => x.toFixed(1)).join(" ")}) — wall ms from the restart request`,
  );
  for (const [name, v] of Object.entries(it.marks))
    r.note(`  ${name.padEnd(42)} ${rel(v)}`);
  const m = it.marks;
  r.note(
    `  HEADLINE ready → every tab settled          ${fmt(m["all tabs settled"]! - m["successor ready (gateway)"]!)} ms`,
  );
  r.note(
    `  HEADLINE socket closed → every tab settled  ${fmt(m["all tabs settled"]! - m["first tab socket closed"]!)} ms`,
  );
  r.note("  per tab: open→settled ms, entries, sub-ack / up-to-date / error");
  for (const t of it.tabs)
    r.note(
      `    ${t.label.padEnd(22)} ${fmt(t.settledAt !== null && t.openAt !== null ? t.settledAt - t.openAt : null).padStart(6)}  ${String(t.entries).padStart(4)}  ${t.answers.subAck}/${t.answers.upToDate}/${t.answers.error}`,
    );
  // Slowest keys as the tabs see them (replay → answer).
  const byKey = new Map<string, { n: number; max: number; sum: number }>();
  for (const t of it.tabs)
    for (const e of t.perEntry) {
      const k = byKey.get(e.key) ?? { n: 0, max: 0, sum: 0 };
      k.n++;
      k.max = Math.max(k.max, e.ms);
      k.sum += e.ms;
      byKey.set(e.key, k);
    }
  r.note("  slowest keys, replay → answer (max / mean ms, entries):");
  for (const [k, v] of [...byKey]
    .sort((a, b) => b[1].max - a[1].max)
    .slice(0, 15))
    r.note(
      `    ${k.padEnd(48)} ${fmt(v.max).padStart(6)} / ${fmt(v.sum / v.n).padStart(6)}  ×${v.n}`,
    );
  r.note(
    "  replay read path on the server, per key (sub spans ≥5 ms after the socket closed): n, replay→span start mean/max, span wall mean/max, self / child / waits by layer (sums)",
  );
  for (const k of [...it.subs]
    .sort((a, b) => b.startDelayMax + b.wallMax - (a.startDelayMax + a.wallMax))
    .slice(0, 20)) {
    const waits = Object.entries(k.waits)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([l, v]) => `${l}=${Math.round(v)}`)
      .join(" ");
    r.note(
      `    ${k.key.padEnd(44)} ×${String(k.n).padStart(3)}  start ${fmt(k.startDelaySum / k.n).padStart(5)}/${fmt(k.startDelayMax).padStart(5)}  wall ${fmt(k.wallSum / k.n).padStart(5)}/${fmt(k.wallMax).padStart(5)}  self ${fmt(k.selfSum)} child ${fmt(k.childSum)} ${waits}`,
    );
  }
  r.note(
    `  event-loop stalls between the first replay and the last tab settled: ${fmt(it.loop.coveredMs)} ms in ${it.loop.stalls.length} (@offset from replay:ms) ${it.loop.stalls.map((x) => `@${x.at}:${x.ms}`).join(" ")}`,
  );
  r.note("  CPU (process user+system ms, from the successor's checkpoints):");
  for (const [name, v] of Object.entries(it.cpu))
    r.note(`    ${name.padEnd(40)} ${fmt(v)}`);
  // Boot spans: the heaviest per phase.
  const spans = it.boot.spans;
  for (const phase of [
    "onReadyBlocking",
    "onReady",
    "onAllReady",
    "warmup",
    "onSettled",
  ] as const) {
    const top = spans
      .filter((s) => s.phase === phase)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 8);
    if (top.length === 0) continue;
    r.note(`  ${phase} slowest (wall ms @ start offset):`);
    for (const s of top)
      r.note(
        `    ${s.label.padEnd(56)} ${fmt(s.durationMs).padStart(6)} @${s.startMs}`,
      );
  }
  const phase = (id: string) => spans.find((s) => s.id === id);
  for (const id of [
    "register",
    "awaitPgReady",
    "runMigrations",
    "routePopulation",
    "socketBind",
    "settled",
  ]) {
    const s = phase(id);
    if (s)
      r.note(
        `  phase ${id.padEnd(20)} ${fmt(s.durationMs).padStart(6)} @${s.startMs}`,
      );
  }
  // Runtime profile: the gates and the loaders.
  r.note(
    "  gates (layer, kind, waits, total ms, longest wait ms, longest queue held ms):",
  );
  for (const g of [...it.runtime.gates].sort((a, b) => b.totalMs - a.totalMs))
    r.note(
      `    ${g.layer.padEnd(28)} ${g.kind.padEnd(5)} ${String(g.count).padStart(6)} ${fmt(g.totalMs).padStart(8)} ${fmt(g.maxWaitMs).padStart(7)} ${fmt(g.longestBusyMs).padStart(7)}`,
    );
  const loaders = it.runtime.aggregates.loader;
  const show = (title: string, list: typeof loaders) => {
    r.note(`  ${title} (count, total, wait, self, max ms; waits by layer):`);
    for (const l of list.slice(0, 15)) {
      const waits = Object.entries(l.waits ?? {})
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${Math.round(v)}`)
        .join(" ");
      r.note(
        `    ${l.label.padEnd(44)} ${String(l.count).padStart(5)} ${fmt(l.totalMs).padStart(8)} ${fmt(l.waitTotalMs).padStart(8)} ${fmt(l.selfTotalMs).padStart(8)} ${fmt(l.maxMs).padStart(6)}  ${waits}`,
      );
    }
  };
  show(
    "loaders by total wall",
    [...loaders].sort((a, b) => b.totalMs - a.totalMs),
  );
  show(
    "loaders by own work (self)",
    [...loaders].sort((a, b) => b.selfTotalMs - a.selfTotalMs),
  );
  const sum = (k: "totalMs" | "waitTotalMs" | "selfTotalMs") =>
    loaders.reduce((a, l) => a + l[k], 0);
  r.note(
    `  loaders summed: ${loaders.reduce((a, l) => a + l.count, 0)} runs, wall ${fmt(sum("totalMs"))}, waiting ${fmt(sum("waitTotalMs"))}, own work ${fmt(sum("selfTotalMs"))} ms`,
  );
  const db = it.runtime.aggregates.db;
  r.note(
    `  db: ${db.reduce((a, l) => a + l.count, 0)} queries, wall ${fmt(db.reduce((a, l) => a + l.totalMs, 0))} ms, waiting ${fmt(db.reduce((a, l) => a + l.waitTotalMs, 0))} ms`,
  );
  const jobs = it.runtime.aggregates.job;
  if (jobs.length > 0) {
    r.note("  jobs by total wall (count, total ms):");
    for (const j of [...jobs].sort((a, b) => b.totalMs - a.totalMs).slice(0, 8))
      r.note(
        `    ${j.label.padEnd(44)} ${String(j.count).padStart(5)} ${fmt(j.totalMs).padStart(8)}`,
      );
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

const results: IterationResult[] = [];

await withBrowser(async (h) => {
  await setHandoff(HANDOFF === "on");

  const tabs: Tab[] = [];
  for (let c = 0; c < CONTEXTS; c++) {
    const session = await h.session();
    for (const [i, path] of PATHS.entries()) {
      const page = i === 0 ? session.page : await session.context.newPage();
      const tap = await tapSharedSocket(page);
      tabs.push(watchTab(`${CONTEXTS > 1 ? `c${c} ` : ""}${path}`, page, tap));
      await boot(page, pathUrl(path), { settleMs: 0 });
    }
  }
  await waitFor(
    () => Promise.resolve(tabs.every((t) => t.tap.connections(WS).length > 0)),
    (ok) => ok,
    { timeoutMs: 30_000, intervalMs: 200 },
  );
  await tabs[0]!.page.waitForTimeout(SETTLE_MS);

  for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
    const connBefore = tabs.map((t) => t.tap.connections(WS).at(-1));
    const t0 = Date.now();
    await restart();
    const swappedAt = Date.now();

    const settled = await waitFor(
      () =>
        Promise.resolve(tabs.map((t, i) => readTabRun(t, t0, connBefore[i]))),
      (runs) => runs.every((x) => x.settledAt !== null),
      { timeoutMs: TIMEOUT_MS, intervalMs: 100 },
    );
    const runs = settled.value;
    r.ok(
      `iteration ${iteration}: every tab answered its whole replay (${runs.reduce((a, t) => a + t.entries, 0)} entries over ${runs.length} tabs)`,
      settled.ok,
      runs
        .filter((x) => x.settledAt === null)
        .map((x) => x.label)
        .join(", "),
    );
    // Read right away: the runtime profile counts from process start, and
    // what runs after the tabs settled is not the storm.
    const runtime = await runtimeProfile();
    const firstClosed = Math.min(
      ...runs.map((x) => x.closedAt ?? Number.POSITIVE_INFINITY),
    );
    const firstReplay = Math.min(
      ...runs.map((x) => x.replayAt ?? Number.POSITIVE_INFINITY),
    );
    const fw = await flightWindow(Date.now() - firstClosed + 2_000);
    const subs = splitSubs(fw, firstClosed, firstReplay);
    const lastSettled = Math.max(...runs.map((x) => x.settledAt ?? 0));
    const loop = stallsDuring(fw, firstReplay, lastSettled);
    const bootNow = await bootProfile();
    const cpuNowMs = bootNow.cpuMsNow ?? null;
    // Then let the successor finish its post-ready work before the next restart.
    const settledBoot = await awaitSettledBoot(t0 - 60_000);

    const min = (xs: Array<number | null>) => {
      const v = xs.filter((x): x is number => x !== null);
      return v.length === 0 ? null : Math.min(...v);
    };
    const max = (xs: Array<number | null>) => {
      const v = xs.filter((x): x is number => x !== null);
      return v.length === runs.length ? Math.max(...v) : null;
    };
    const procStart = bootNow.processStartedAt;
    const base = procStart + bootNow.bootStartOffsetMs;
    const cp = (label: string) =>
      bootNow.memoryCheckpoints.find((c) => c.label === label);
    const cpAt = (label: string) => {
      const c = cp(label);
      return c ? base + c.atMs : null;
    };
    const marks: Record<string, number | null> = {
      "gateway spawn requested": bootNow.gateway?.spawnRequestedAt ?? null,
      "successor process start": procStart,
      "successor onReadyBlocking done": cpAt("after-onReadyBlocking"),
      "successor ready (gateway)": bootNow.gateway?.readyObservedAt ?? null,
      "swap (restart request answered)": swappedAt,
      "first tab socket closed": min(runs.map((x) => x.closedAt)),
      "first tab reconnected": min(runs.map((x) => x.openAt)),
      "last tab reconnected": max(runs.map((x) => x.openAt)),
      "successor onReady done": cpAt("after-onReady"),
      "first tab settled": min(runs.map((x) => x.settledAt)),
      "all tabs settled": max(runs.map((x) => x.settledAt)),
      "successor settled phase done": (() => {
        const c = settledBoot.memoryCheckpoints.find(
          (x) => x.label === "after-settled",
        );
        return c
          ? settledBoot.processStartedAt +
              settledBoot.bootStartOffsetMs +
              c.atMs
          : null;
      })(),
    };
    const cpuAt = (label: string) => cp(label)?.cpuMs ?? null;
    const diff = (a: number | null, b: number | null) =>
      a === null || b === null ? null : a - b;
    const settledCp = settledBoot.memoryCheckpoints.find(
      (x) => x.label === "after-settled",
    );
    const cpu: Record<string, number | null> = {
      "process start → boot-start": cpuAt("boot-start"),
      "boot-start → onReadyBlocking done": diff(
        cpuAt("after-onReadyBlocking"),
        cpuAt("boot-start"),
      ),
      "onReadyBlocking → onReady done": diff(
        cpuAt("after-onReady"),
        cpuAt("after-onReadyBlocking"),
      ),
      "process start → tabs settled (read)": cpuNowMs,
      "process start → settled phase done": settledCp?.cpuMs ?? null,
    };
    const it: IterationResult = {
      iteration,
      t0,
      marks,
      tabs: runs,
      cpu,
      boot: settledBoot,
      runtime,
      subs,
      loop,
      flight: fw,
      loadavg: loadavg(),
    };
    results.push(it);
    printIteration(it);
    await tabs[0]!.page.waitForTimeout(SETTLE_MS);
  }

  // Summary across iterations.
  const pick = (f: (it: IterationResult) => number | null) =>
    results
      .map(f)
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
  const median = (xs: number[]) =>
    xs.length === 0 ? null : xs[Math.floor(xs.length / 2)]!;
  const row = (name: string, f: (it: IterationResult) => number | null) => {
    const xs = pick(f);
    r.note(
      `  ${name.padEnd(48)} median ${fmt(median(xs))}  min ${fmt(xs[0])}  max ${fmt(xs.at(-1))}`,
    );
  };
  r.note(
    `── SUMMARY (handoff ${HANDOFF}, ${tabs.length} tabs, ${results.length} restarts)`,
  );
  const m = (it: IterationResult, a: string, b: string) =>
    it.marks[a] != null && it.marks[b] != null
      ? it.marks[a]! - it.marks[b]!
      : null;
  row("restart request → successor ready", (it) =>
    m(it, "successor ready (gateway)", "swap (restart request answered)") ===
    null
      ? null
      : it.marks["successor ready (gateway)"]! - it.t0,
  );
  row("process start → onReadyBlocking done", (it) =>
    m(it, "successor onReadyBlocking done", "successor process start"),
  );
  row("ready → first tab socket closed (old drain)", (it) =>
    m(it, "first tab socket closed", "successor ready (gateway)"),
  );
  row("socket closed → every tab settled (stale window)", (it) =>
    m(it, "all tabs settled", "first tab socket closed"),
  );
  row("ready → every tab settled", (it) =>
    m(it, "all tabs settled", "successor ready (gateway)"),
  );
  row("replayed entries (all tabs)", (it) =>
    it.tabs.reduce((a, t) => a + t.entries, 0),
  );
  row("entries reloaded (sub-ack)", (it) =>
    it.tabs.reduce((a, t) => a + t.answers.subAck, 0),
  );
  row(
    "read-admit waits",
    (it) => it.runtime.gates.find((g) => g.layer === "read-admit")?.count ?? 0,
  );
  row(
    "read-admit wait ms (sum)",
    (it) =>
      it.runtime.gates.find((g) => g.layer === "read-admit")?.totalMs ?? 0,
  );
  // What a reader felt (the exit criterion's measure): the longest single
  // read-admit wait, and the longest the queue held without a break — the
  // time the replay burst took to drain.
  row(
    "read-admit longest single wait ms",
    (it) =>
      it.runtime.gates.find((g) => g.layer === "read-admit")?.maxWaitMs ?? 0,
  );
  row(
    "read-admit longest burst drain ms (queue held)",
    (it) =>
      it.runtime.gates.find((g) => g.layer === "read-admit")?.longestBusyMs ??
      0,
  );
  row(
    "background-acquire wait ms (sum)",
    (it) =>
      it.runtime.gates.find((g) => g.layer === "background-acquire")?.totalMs ??
      0,
  );
  row("event-loop stalls, replay → settled (ms)", (it) => it.loop.coveredMs);
  row("CPU process start → onReadyBlocking done", (it) =>
    it.cpu["boot-start → onReadyBlocking done"] !== null &&
    it.cpu["process start → boot-start"] !== null
      ? it.cpu["boot-start → onReadyBlocking done"]! +
        it.cpu["process start → boot-start"]!
      : null,
  );
  row(
    "CPU process start → tabs settled",
    (it) => it.cpu["process start → tabs settled (read)"] ?? null,
  );
  row(
    "CPU process start → settled phase done",
    (it) => it.cpu["process start → settled phase done"] ?? null,
  );

  if (OUT !== "") {
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          namespace,
          handoff: HANDOFF,
          paths: PATHS,
          contexts: CONTEXTS,
          results,
        },
        null,
        1,
      ),
    );
    r.note(`raw results → ${OUT}`);
  }
});

await r.finish();
