// Cold-start benchmark: page request → first screen with data, on a stopped
// worktree server, split across the gateway, the server's boot phases and the
// browser's boot trace. See this plugin's CLAUDE.md for what each number means.
//
// Usage:
//   ./singularity run plugins/debug/plugins/profiling/plugins/cold-start/e2e/cold-start.ts \
//     [--iterations 5] [--path /agents] [--busy N] [--out /tmp/cold-start.json] \
//     [--no-stop] [--timeout 60000]
//
// --busy N   N CPU-spinning children at background priority for the whole run
//            (standing in for agent builds); always killed at the end.
// --no-stop  WARM run: skips the stop, so the server is already up and its boot
//            phases belong to an earlier boot (printed without a timeline offset).

import { cpus, loadavg } from "node:os";
import type { Subprocess } from "bun";
import {
  agentFetch,
  flag,
  numArg,
  arg,
  onBeforeFinish,
  pageUrl,
  report,
  targetNamespace,
  usage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { backgroundArgv } from "@plugins/packages/plugins/spawn-priority/core";
import {
  BOOT_TIMING_PREFIX,
  FIRST_DATA_COMMIT_ID,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import type { BootTimingDetail } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import { ProfilingDataSchema } from "@plugins/debug/plugins/profiling/plugins/boot/core";
import type { ProfilingData } from "@plugins/debug/plugins/profiling/plugins/boot/core";

const iterations = numArg("iterations", 5);
const busy = numArg("busy", 0);
const timeoutMs = numArg("timeout", 60_000);
const out = arg("out");
const warm = flag("no-stop");
const url = pageUrl("/agents");
const namespace = targetNamespace();
if (!Number.isInteger(iterations) || iterations < 1)
  usage(`--iterations expects a positive integer, got ${iterations}`);
if (!Number.isInteger(busy) || busy < 0)
  usage(`--busy expects a non-negative integer, got ${busy}`);

const r = report(`cold-start ${warm ? "(WARM — server not stopped)" : ""}`);

// Before the spinners start: the host as the run found it.
const loadStart = loadavg();

// --- Busy load ------------------------------------------------------------------

const spinners: Subprocess[] = [];
function killSpinners(): void {
  for (const s of spinners.splice(0)) s.kill("SIGKILL");
}
if (busy > 0) {
  for (let i = 0; i < busy; i++) {
    spinners.push(
      Bun.spawn(backgroundArgv([process.execPath, "-e", "for(;;){}"]), {
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
  }
  // Every exit path: finish() runs the before-finish hooks, a crash or a
  // usage() exit reaches "exit", Ctrl-C reaches SIGINT.
  onBeforeFinish(async () => killSpinners());
  process.on("exit", killSpinners);
  process.on("SIGINT", () => {
    killSpinners();
    process.exit(130);
  });
}

// --- One iteration ----------------------------------------------------------------

/** One boot User Timing entry, as read from the page (startTime on the page clock). */
interface TimingEntry {
  id: string;
  kind: "mark" | "measure";
  startMs: number;
  durationMs: number;
  detail: BootTimingDetail;
}

interface PageTimings {
  /** Epoch ms of the page's navigation start — the timeline's zero. */
  timeOrigin: number;
  responseStartMs: number | null;
  domContentLoadedMs: number | null;
  firstContentfulPaintMs: number | null;
  entries: TimingEntry[];
}

interface Iteration {
  /** Epoch ms the stop returned (cold runs only). */
  stoppedAt: number | null;
  /** Epoch ms just before page.goto. */
  gotoAt: number;
  page: PageTimings;
  server: ProfilingData;
  loadAvgEnd: number[];
}

async function stopServer(): Promise<number> {
  const res = await agentFetch(
    `/gateway/worktrees/${encodeURIComponent(namespace)}/stop`,
    { method: "POST" },
  );
  const body = await res.text();
  // The machine's gateway is built from main's Go source: a 404 here is a
  // gateway that predates the route, not a missing worktree.
  if (res.status === 404)
    throw new Error(
      `POST /gateway/worktrees/${namespace}/stop → 404: the gateway predates the stop route — needs main's gateway with it (or run --no-stop for a warm check)`,
    );
  if (!res.ok)
    throw new Error(`stop ${namespace}: HTTP ${res.status} ${body.trim()}`);
  const status = JSON.parse(body) as { state?: unknown };
  r.eq(`stop ${namespace} → idle`, status.state, "idle");
  return Date.now();
}

// The later of the two end instants: route content commits at or after the
// first data commit.
const routeContentName = `${BOOT_TIMING_PREFIX}${ROUTE_CONTENT_COMMIT_ID}`;

const iterationsRun = await withBrowser(async (h) => {
  const runs: Iteration[] = [];
  for (let i = 0; i < iterations; i++) {
    const stoppedAt = warm ? null : await stopServer();
    const { context, page } = await h.session();
    const gotoAt = Date.now();
    await page.goto(url, { waitUntil: "commit", timeout: timeoutMs });
    // Push-based wait: a buffered PerformanceObserver resolves on the mark
    // (or on one already recorded), the in-page timer bounds it.
    await page.evaluate(
      ([name, limitMs]) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error(`${name} not recorded within ${limitMs} ms`)),
            limitMs,
          );
          new PerformanceObserver((list, obs) => {
            if (list.getEntriesByName(name).length === 0) return;
            clearTimeout(timer);
            obs.disconnect();
            resolve();
          }).observe({ type: "mark", buffered: true });
        }),
      [routeContentName, timeoutMs] as const,
    );
    const pageTimings = await page.evaluate((prefix): PageTimings => {
      const nav = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
      const fcp = performance
        .getEntriesByType("paint")
        .find((e) => e.name === "first-contentful-paint");
      const entries = [
        ...performance.getEntriesByType("mark"),
        ...performance.getEntriesByType("measure"),
      ]
        .filter((e) => e.name.startsWith(prefix))
        .map((e) => ({
          id: e.name.slice(prefix.length),
          kind: e.entryType as "mark" | "measure",
          startMs: e.startTime,
          durationMs: e.duration,
          detail: (e as PerformanceMark | PerformanceMeasure)
            .detail as BootTimingDetail,
        }));
      return {
        timeOrigin: performance.timeOrigin,
        responseStartMs: nav ? nav.responseStart : null,
        domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
        firstContentfulPaintMs: fcp ? fcp.startTime : null,
        entries,
      };
    }, BOOT_TIMING_PREFIX);
    // Close BEFORE the next stop: an open page's socket would respawn the
    // server the moment it exits.
    await context.close();
    const res = await agentFetch("/api/debug/profiling/boot");
    if (!res.ok)
      throw new Error(`GET /api/debug/profiling/boot: HTTP ${res.status}`);
    const server = ProfilingDataSchema.parse(await res.json());
    runs.push({
      stoppedAt,
      gotoAt,
      page: pageTimings,
      server,
      loadAvgEnd: loadavg(),
    });
    console.log(
      `  #${i + 1}: first data at ${ms(entryStart(pageTimings, FIRST_DATA_COMMIT_ID))} ms, route content at ${ms(entryStart(pageTimings, ROUTE_CONTENT_COMMIT_ID))} ms`,
    );
  }
  return runs;
});

// --- Derivation -------------------------------------------------------------------

/** A phase on the timeline: its duration and where it ends, both in ms. `endAt` is null when it has no place on this load's timeline (a warm run's server boot). */
interface Phase {
  name: string;
  durationMs: number;
  endAt: number | null;
}

const ROUTE_CONTENT_ROW = "TOTAL page request → route content commit";
const FIRST_DATA_ROW = "TOTAL page request → first data commit";

function entryStart(p: PageTimings, id: string): number | null {
  return p.entries.find((e) => e.id === id)?.startMs ?? null;
}

function phasesOf(run: Iteration): Phase[] {
  const phases: Phase[] = [];
  const zero = run.page.timeOrigin;
  const push = (name: string, durationMs: number, endAt: number | null) =>
    phases.push({ name, durationMs, endAt });
  const onTimeline = !warm;
  const at = (epochMs: number): number | null =>
    onTimeline ? epochMs - zero : null;

  // Totals. The headline is route content: the first screen a person sees
  // with data.
  const routeContent = entryStart(run.page, ROUTE_CONTENT_COMMIT_ID);
  if (routeContent !== null)
    push(ROUTE_CONTENT_ROW, routeContent, routeContent);
  const firstData = entryStart(run.page, FIRST_DATA_COMMIT_ID);
  if (firstData !== null) push(FIRST_DATA_ROW, firstData, firstData);

  // Gateway.
  const g = run.server.gateway;
  if (g?.spawnRequestedAt !== undefined && g.readyObservedAt !== undefined) {
    push(
      "gateway spawn requested → ready observed",
      g.readyObservedAt - g.spawnRequestedAt,
      at(g.readyObservedAt),
    );
    if (g.spawnedAt !== undefined) {
      push(
        "  gateway spawn requested → spawned",
        g.spawnedAt - g.spawnRequestedAt,
        at(g.spawnedAt),
      );
      push(
        "  gateway spawned → ready observed",
        g.readyObservedAt - g.spawnedAt,
        at(g.readyObservedAt),
      );
      // exec + the Bun runtime's own start, before any of our code runs.
      push(
        "  gateway spawned → server process start",
        run.server.processStartedAt - g.spawnedAt,
        at(run.server.processStartedAt),
      );
    }
  }

  // Server. Span offsets are from the profiler's boot start, which sits
  // bootStartOffsetMs after process start.
  const s = run.server;
  const base = s.processStartedAt + s.bootStartOffsetMs;
  const register = s.spans.filter((x) => x.phase === "register");
  if (register.length > 0) {
    const regStart = Math.min(...register.map((x) => x.startMs));
    const regEnd = Math.max(...register.map((x) => x.startMs + x.durationMs));
    push(
      "server process start → first register (code loading)",
      s.bootStartOffsetMs + regStart,
      at(base + regStart),
    );
    push("server register", regEnd - regStart, at(base + regEnd));
  }
  for (const phase of [
    "awaitPgReady",
    "runMigrations",
    "routePopulation",
    "socketBind",
  ]) {
    const span = s.spans.find(
      (x) => x.phase === phase && x.plugin === undefined,
    );
    if (span)
      push(
        `server ${phase}`,
        span.durationMs,
        at(base + span.startMs + span.durationMs),
      );
  }
  const blocking = s.spans.find(
    (x) => x.id === "onReadyBlocking" && x.plugin === undefined,
  );
  if (blocking) {
    const end = blocking.startMs + blocking.durationMs;
    push("server onReadyBlocking (all)", blocking.durationMs, at(base + end));
    for (const span of s.spans.filter(
      (x) => x.phase === "onReadyBlocking" && x.plugin !== undefined,
    )) {
      push(
        `  onReadyBlocking ${span.plugin}`,
        span.durationMs,
        at(base + span.startMs + span.durationMs),
      );
    }
    push(
      "server ready (process start → onReadyBlocking end)",
      s.bootStartOffsetMs + end,
      at(base + end),
    );
  }

  // Browser.
  const p = run.page;
  if (p.responseStartMs !== null)
    push("document first byte (TTFB)", p.responseStartMs, p.responseStartMs);
  if (p.domContentLoadedMs !== null)
    push("DOMContentLoaded", p.domContentLoadedMs, p.domContentLoadedMs);
  if (p.firstContentfulPaintMs !== null)
    push(
      "first contentful paint",
      p.firstContentfulPaintMs,
      p.firstContentfulPaintMs,
    );
  for (const id of ["load-plugins", "boot-tasks", "boot-snapshot"]) {
    const e = p.entries.find((x) => x.id === id);
    if (e) push(`client ${id}`, e.durationMs, e.startMs + e.durationMs);
  }
  const setState = entryStart(p, "set-state");
  if (setState !== null)
    push("client set-state (first render scheduled)", setState, setState);
  return phases;
}

/** Per-entry snapshot rows: resource key, source, server work. */
function snapshotEntries(
  run: Iteration,
): { key: string; source: string; workMs: number }[] {
  return run.page.entries
    .filter((e) => e.id.startsWith("res:"))
    .map((e) => ({
      key: e.id.slice("res:".length),
      source: e.detail.detail ?? "?",
      workMs: e.detail.workMs ?? 0,
    }));
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)] ?? NaN;
}
function stats(values: number[]): { min: number; median: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? NaN,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}
// A declaration (hoisted): the iteration loop above logs with it.
function ms(n: number | null): string {
  return n === null || Number.isNaN(n) ? "—" : String(Math.round(n));
}

// --- Assertions -------------------------------------------------------------------

for (const [i, run] of iterationsRun.entries()) {
  const tag = `#${i + 1}`;
  r.ok(
    `${tag} first data commit recorded`,
    entryStart(run.page, FIRST_DATA_COMMIT_ID) !== null,
  );
  r.ok(
    `${tag} route content commit recorded`,
    entryStart(run.page, ROUTE_CONTENT_COMMIT_ID) !== null,
  );
  if (warm) continue;
  const g = run.server.gateway;
  r.ok(
    `${tag} gateway report present`,
    g?.spawnRequestedAt !== undefined && g.readyObservedAt !== undefined,
    "the gateway did not POST /api/boot/gateway-report for this boot",
  );
  // The boot measured must be the one this load caused: the server process
  // started after the stop returned.
  r.ok(
    `${tag} server boot started after the stop`,
    run.stoppedAt !== null && run.server.processStartedAt >= run.stoppedAt,
    `process started ${ms(run.server.processStartedAt - (run.stoppedAt ?? 0))} ms after the stop — something else restarted it first`,
  );
}

// --- Report -----------------------------------------------------------------------

const perRun = iterationsRun.map(phasesOf);
const names: string[] = [];
for (const phases of perRun)
  for (const ph of phases) if (!names.includes(ph.name)) names.push(ph.name);

const loadEnd = iterationsRun.at(-1)?.loadAvgEnd ?? loadavg();

console.log("");
console.log(
  `=== cold-start ${url} — ${iterationsRun.length} iteration(s), busy=${busy}, ${warm ? "WARM (no stop)" : "cold"} ===`,
);
console.log(
  `clock: one host wall clock — page timeOrigin, server timeOrigin and gateway stamps are epoch ms; offsets are relative to the page request (navigation start).`,
);
const W = 56;
console.log(
  `${"phase".padEnd(W)} ${"min".padStart(6)} ${"median".padStart(7)} ${"p95".padStart(6)}   ${"ends at (median)".padStart(16)}`,
);
console.log(
  `${"-".repeat(W)} ${"-".repeat(6)} ${"-".repeat(7)} ${"-".repeat(6)}   ${"-".repeat(16)}`,
);
const medians = new Map<string, number>();
for (const name of names) {
  const rows = perRun.flatMap((phases) =>
    phases.filter((p) => p.name === name),
  );
  const d = stats(rows.map((x) => x.durationMs));
  medians.set(name, d.median);
  const ends = rows.map((x) => x.endAt).filter((x): x is number => x !== null);
  const endMedian = ends.length > 0 ? stats(ends).median : null;
  console.log(
    `${name.slice(0, W).padEnd(W)} ${ms(d.min).padStart(6)} ${ms(d.median).padStart(7)} ${ms(d.p95).padStart(6)}   ${ms(endMedian).padStart(16)}`,
  );
}

// Snapshot entries: by source, then the heaviest keys by median server work.
const bySource = new Map<string, number[]>();
const byKey = new Map<string, { source: string; work: number[] }>();
for (const run of iterationsRun) {
  const counts = new Map<string, number>();
  for (const e of snapshotEntries(run)) {
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
    const k = byKey.get(e.key) ?? { source: e.source, work: [] };
    k.work.push(e.workMs);
    k.source = e.source;
    byKey.set(e.key, k);
  }
  for (const [src, n] of counts)
    bySource.set(src, [...(bySource.get(src) ?? []), n]);
}
console.log("");
console.log(
  `boot snapshot entries by source (median count): ${[...bySource].map(([s, n]) => `${s} ${stats(n).median}`).join(", ") || "none"}`,
);
const heaviest = [...byKey]
  .map(([key, v]) => ({ key, source: v.source, median: stats(v.work).median }))
  .sort((a, b) => b.median - a.median)
  .slice(0, 8);
for (const e of heaviest)
  console.log(
    `  ${e.key.slice(0, 50).padEnd(50)} ${e.source.padEnd(9)} work ${ms(e.median)} ms`,
  );

const fmtLoad = (l: number[]): string => l.map((x) => x.toFixed(2)).join(" ");
console.log("");
console.log(
  `load average (1/5/15 min, ${cpus().length} cpus): start ${fmtLoad(loadStart)} → end ${fmtLoad(loadEnd)}`,
);

const med = (name: string): string => ms(medians.get(name) ?? null);
const totalOf = (name: string) =>
  stats(
    perRun.flatMap((phases) =>
      phases.filter((p) => p.name === name).map((p) => p.durationMs),
    ),
  );
const total = totalOf(ROUTE_CONTENT_ROW);
const firstDataTotal = totalOf(FIRST_DATA_ROW);
console.log("");
console.log(
  `SUMMARY cold-start${warm ? " WARM" : ""} ${new URL(url).pathname} n=${iterationsRun.length} busy=${busy}: ` +
    `route content median ${ms(total.median)} ms (p95 ${ms(total.p95)}) | ` +
    `first data ${ms(firstDataTotal.median)} (p95 ${ms(firstDataTotal.p95)}) | ` +
    `gateway spawn→ready ${med("gateway spawn requested → ready observed")} | ` +
    `code load ${med("server process start → first register (code loading)")} | ` +
    `onReadyBlocking ${med("server onReadyBlocking (all)")} | ` +
    `snapshot ${med("client boot-snapshot")} | ` +
    `load ${loadStart[0]?.toFixed(2)}→${loadEnd[0]?.toFixed(2)}`,
);

if (out) {
  await Bun.write(
    out,
    JSON.stringify(
      {
        url,
        namespace,
        warm,
        busy,
        capturedAt: new Date().toISOString(),
        loadAvg: { start: loadStart, end: loadEnd },
        iterations: iterationsRun.map((run, i) => ({
          ...run,
          phases: perRun[i],
          snapshotEntries: snapshotEntries(run),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${out}`);
}

await r.finish();
