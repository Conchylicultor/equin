/**
 * Load probe for a gateway update: drives a site with steady traffic while the
 * gateway is replaced (a handover, a service restart, a host restart), and
 * says what a visitor saw.
 *
 *   ./equin run plugins/infra/plugins/launcher/scripts/gateway-load-probe.ts \
 *     --url https://equin.ai [--seconds 90] [--workers 6] [--websockets 2] \
 *     [--out "$EQUIN_SCRATCH/probe.json"]
 *
 * Each worker cycles a page GET, `GET /api/health` (whose `startedAt` names
 * the backend PROCESS — a change is a backend cold start or swap) and an
 * invalid `POST /api/analytics/collect` (answered 400 by the backend, writes
 * nothing), each on its own keep-alive connection pool. A request FAILS on a
 * network error or a 502/503/504; any other answer reached the backend.
 * `--websockets` holds that many `/ws/notifications` sockets open and counts
 * how often one closed and how long its reconnect took.
 *
 * Prints, and writes to `--out`: requests, failures (with the first errors),
 * latency p50 / p99 / max, the slowest requests with when they started, the
 * backend `startedAt` values seen with their first/last sighting, and the
 * WebSocket closes. Design: research/2026-11-14-gateway-handover.md.
 */
import { writeFileSync } from "node:fs";

interface Opts {
  url: string;
  seconds: number;
  workers: number;
  websockets: number;
  out: string | null;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    url: "",
    seconds: 90,
    workers: 6,
    websockets: 2,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const v = argv[i + 1];
    switch (a) {
      case "--url":
        opts.url = v ?? "";
        i++;
        break;
      case "--seconds":
        opts.seconds = Number(v);
        i++;
        break;
      case "--workers":
        opts.workers = Number(v);
        i++;
        break;
      case "--websockets":
        opts.websockets = Number(v);
        i++;
        break;
      case "--out":
        opts.out = v ?? null;
        i++;
        break;
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  if (opts.url === "") throw new Error("--url <origin> is required");
  opts.url = opts.url.replace(/\/$/, "");
  return opts;
}

interface Sample {
  at: number;
  kind: string;
  ms: number;
  status: number | null;
  error: string | null;
}

const FAILING_STATUS = new Set([502, 503, 504]);

async function timed(
  kind: string,
  run: () => Promise<Response>,
  samples: Sample[],
  onBody?: (text: string) => void,
): Promise<void> {
  const at = Date.now();
  const t0 = performance.now();
  try {
    const res = await run();
    const text = await res.text();
    const ms = performance.now() - t0;
    samples.push({
      at,
      kind,
      ms,
      status: res.status,
      error: FAILING_STATUS.has(res.status) ? text.slice(0, 200) : null,
    });
    if (res.ok && onBody) onBody(text);
  } catch (err) {
    samples.push({
      at,
      kind,
      ms: performance.now() - t0,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const until = Date.now() + opts.seconds * 1000;
  const samples: Sample[] = [];
  const backends = new Map<number, { first: number; last: number }>();
  const sawBackend = (text: string) => {
    const parsed = JSON.parse(text) as { startedAt?: number };
    if (typeof parsed.startedAt !== "number") return;
    const now = Date.now();
    const seen = backends.get(parsed.startedAt);
    if (seen === undefined) {
      backends.set(parsed.startedAt, { first: now, last: now });
    } else {
      seen.last = now;
    }
  };

  const worker = async (i: number) => {
    let n = i;
    while (Date.now() < until) {
      switch (n % 3) {
        case 0:
          await timed("page", () => fetch(`${opts.url}/`), samples);
          break;
        case 1:
          await timed(
            "health",
            () => fetch(`${opts.url}/api/health`),
            samples,
            sawBackend,
          );
          break;
        default:
          await timed(
            "post",
            () =>
              fetch(`${opts.url}/api/analytics/collect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }),
            samples,
          );
      }
      n++;
      // A failed request backs off like a client would, instead of spinning:
      // the failure count then reads as requests a visitor made, not as how
      // fast a refused connect returns.
      if (samples.at(-1)?.error != null) await Bun.sleep(100);
    }
  };

  const wsEvents: { closedAt: number; reopenedMs: number | null }[] = [];
  const wsUrl = `${opts.url.replace(/^http/, "ws")}/ws/notifications`;
  const holdSocket = async () => {
    while (Date.now() < until) {
      const closedAt = await new Promise<number>((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(
          () => ws.close(),
          Math.max(0, until - Date.now()),
        );
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          resolve(Date.now());
        });
      });
      if (Date.now() >= until) return;
      const ev = { closedAt, reopenedMs: null as number | null };
      wsEvents.push(ev);
      const t0 = Date.now();
      await new Promise<void>((resolve) => {
        const probe = new WebSocket(wsUrl);
        probe.addEventListener("open", () => {
          ev.reopenedMs = Date.now() - t0;
          probe.close();
          resolve();
        });
        probe.addEventListener("error", () => resolve());
      });
      if (ev.reopenedMs === null) await Bun.sleep(100);
    }
  };

  const started = Date.now();
  await Promise.all([
    ...Array.from({ length: opts.workers }, (_, i) => worker(i)),
    ...Array.from({ length: opts.websockets }, () => holdSocket()),
  ]);

  const failed = samples.filter((s) => s.error !== null);
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const slowest = [...samples]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8)
    .map((s) => ({
      tSec: Math.round((s.at - started) / 100) / 10,
      kind: s.kind,
      ms: Math.round(s.ms),
      status: s.status,
    }));
  const summary = {
    url: opts.url,
    seconds: opts.seconds,
    requests: samples.length,
    failed: failed.length,
    firstErrors: failed.slice(0, 10).map((s) => ({
      tSec: Math.round((s.at - started) / 100) / 10,
      kind: s.kind,
      status: s.status,
      error: s.error,
    })),
    latencyMs: {
      p50: Math.round(quantile(ms, 0.5)),
      p99: Math.round(quantile(ms, 0.99)),
      max: Math.round(ms.at(-1) ?? 0),
    },
    slowest,
    backends: [...backends.entries()].map(([startedAt, seen]) => ({
      startedAt,
      firstSeenSec: Math.round((seen.first - started) / 100) / 10,
      lastSeenSec: Math.round((seen.last - started) / 100) / 10,
    })),
    failureWindowSec:
      failed.length === 0
        ? null
        : {
            from: Math.round((failed[0]!.at - started) / 100) / 10,
            to: Math.round((failed.at(-1)!.at - started) / 100) / 10,
          },
    websockets: {
      closes: wsEvents.length,
      reopenFailed: wsEvents.filter((e) => e.reopenedMs === null).length,
      maxReopenMs: Math.max(0, ...wsEvents.map((e) => e.reopenedMs ?? 0)),
      firstCloseSec:
        wsEvents.length === 0
          ? null
          : Math.round((wsEvents[0]!.closedAt - started) / 100) / 10,
    },
  };
  const text = JSON.stringify(summary, null, 2);
  console.log(text);
  if (opts.out !== null) writeFileSync(opts.out, text + "\n");
}

await main();
