/**
 * What a first "Enter equin" costs a visitor: every byte the click downloads
 * (the page's and the demo host's SharedWorker's, per file, as sent on the
 * wire), and the time from the click to the Agent Manager shown, split by the
 * host's own boot stages.
 *
 * Each run is a fresh browser context (empty HTTP cache, no IndexedDB): the
 * homepage loads, then the script clicks Enter equin and waits until the demo
 * is usable: its boot screen gone, then no loader left on the page. The network is shaped by a CONNECT proxy this script
 * runs (a token bucket per direction, shared by every connection, plus half
 * the RTT each way) — never DevTools throttling, which hangs these loads.
 * `--profile desktop` runs unshaped. CPU is not throttled: the boot stages are
 * this machine's.
 *
 * What it prints, per run: the click → usable time, the host's boot line
 * (`[demo-scope] … host ready in …`: its stages — `script` the worker's code,
 * `storage` opening the database with the snapshot's download and restore,
 * `graph` loading and booting the server plugins, `ready` the post-ready
 * phases), the bytes after the click by kind and the largest files. Bytes are
 * CDP's `encodedDataLength` (headers + body as sent); the proxy's own count of
 * TLS bytes is printed beside them as a cross-check (a SharedWorker's first
 * requests, sent before the tap attaches, are only in the proxy's count).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/website/plugins/landing/plugins/screenshot/e2e/enter-cost.ts \
 *     --url https://equin.ai [--profile desktop|fast4g|slow4g] [--runs 1] [--top 25] [--out <prefix>] [--no-record]
 */
import { createServer, connect, type Socket } from "node:net";
import type { Request as PwRequest } from "playwright";
import {
  arg,
  numArg,
  pathUrl,
  report,
  tapSharedWorkerRequests,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitForNotBusy } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { ENTER_DEMO } from "./internal/demo-pages";

interface Shape {
  /** Downlink, kbit/s. */
  downKbps: number;
  /** Uplink, kbit/s. */
  upKbps: number;
  /** Round trip added to every connection, ms. */
  rttMs: number;
}

/** The profiles the load-model research measured with (fast 4G is its §2 profile, slow 4G Lighthouse's). */
const PROFILES: Record<string, Shape | null> = {
  desktop: null,
  fast4g: { downKbps: 9000, upKbps: 1500, rttMs: 60 },
  slow4g: { downKbps: 1600, upKbps: 750, rttMs: 150 },
};

const PROFILE = arg("profile") ?? "fast4g";
const RUNS = numArg("runs", 1);
const TOP = numArg("top", 25);
const OUT = arg("out") ?? "/tmp/enter-cost";
const USABLE_TIMEOUT_MS = numArg("timeout", 300_000);

interface Shaper {
  port: number;
  /** TLS bytes delivered to the browser so far. */
  downBytes(): number;
  close(): Promise<void>;
}

/** One direction of the shaped link: chunks leave it serialized at its rate, then travel half the RTT. */
class Lane {
  private nextFree = 0;
  bytes = 0;
  constructor(
    private readonly bytesPerMs: number,
    private readonly oneWayMs: number,
  ) {}
  /** When `len` bytes handed over now arrive, as a delay from now. */
  schedule(len: number): number {
    const now = performance.now();
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + len / this.bytesPerMs;
    this.bytes += len;
    return this.nextFree + this.oneWayMs - now;
  }
}

/** A CONNECT proxy shaping every tunnel through two shared lanes. */
async function startShaper(shape: Shape): Promise<Shaper> {
  const down = new Lane((shape.downKbps * 1000) / 8 / 1000, shape.rttMs / 2);
  const up = new Lane((shape.upKbps * 1000) / 8 / 1000, shape.rttMs / 2);
  const sockets = new Set<Socket>();
  // One FIFO per direction of a tunnel: a chunk is written when its arrival
  // time comes, never before the chunk ahead of it (timers round to whole
  // ms, so one timer per chunk could swap two — and corrupt the TLS stream).
  const pipe = (from: Socket, to: Socket, lane: Lane) => {
    const queue: Array<{ at: number; chunk: Buffer | null }> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const drain = () => {
      timer = null;
      const now = performance.now();
      while (queue.length > 0 && queue[0]!.at <= now + 0.5) {
        const { chunk } = queue.shift()!;
        if (to.destroyed) return;
        if (chunk === null) to.end();
        else to.write(chunk);
      }
      if (queue.length > 0)
        timer = setTimeout(drain, Math.max(0, queue[0]!.at - now));
    };
    const enqueue = (at: number, chunk: Buffer | null) => {
      queue.push({ at, chunk });
      if (timer === null)
        timer = setTimeout(
          drain,
          Math.max(0, queue[0]!.at - performance.now()),
        );
    };
    from.on("data", (chunk: Buffer) => {
      enqueue(performance.now() + lane.schedule(chunk.length), chunk);
    });
    from.on("end", () => {
      const last = queue.at(-1)?.at ?? performance.now();
      enqueue(last, null);
    });
    from.on("error", () => to.destroy());
  };
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.once("data", (head: Buffer) => {
      const line = head.toString("latin1").split("\r\n")[0] ?? "";
      const m = /^CONNECT ([^:\s]+):(\d+) /.exec(line);
      if (m === null) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      const upstream = connect(Number(m[2]), m[1]!, () => {
        // The tunnel opens after one round trip, as a real connection would.
        setTimeout(() => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipe(upstream, client, down);
          pipe(client, upstream, up);
        }, shape.rttMs);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
    client.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("shaper: no TCP address");
  return {
    port: address.port,
    downBytes: () => down.bytes,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

interface Fetched {
  who: "page" | "worker";
  url: string;
  encodedBytes: number;
  encoding: string;
  sentAt: number;
  finishedAt: number;
}

/** What a file is, for the per-kind totals. */
function kindOf(url: string): string {
  const path = new URL(url).pathname;
  if (path.endsWith("/snapshot.bin")) return "snapshot";
  if (/\.wasm$/.test(path)) return "wasm";
  if (/\.data$/.test(path)) return "postgres share (.data)";
  if (path.includes("/worker-tree.")) return "worker code";
  if (path.endsWith(".css")) return "css";
  if (/\.(m?js)$/.test(path)) return "page code";
  if (path.startsWith("/api/")) return "api";
  return "other";
}

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const short = (url: string) => {
  const u = new URL(url);
  return u.pathname.replace(/^\/artifacts\/[^/]+\//, "…/");
};

await withBrowser(async (h) => {
  const r = report(`enter-cost (${PROFILE})`);
  if (!(PROFILE in PROFILES))
    throw new Error(
      `--profile ${PROFILE}: one of ${Object.keys(PROFILES).join(", ")}`,
    );
  const shape = PROFILES[PROFILE] ?? null;
  const url = pathUrl(arg("path") ?? "/");
  for (let run = 1; run <= RUNS; run++) {
    const shaper = shape === null ? null : await startShaper(shape);
    const tap = await tapSharedWorkerRequests(h.browser);
    const context = await h.browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(shaper === null
        ? {}
        : { proxy: { server: `http://127.0.0.1:${shaper.port}` } }),
    });
    const page = await context.newPage();
    const pageFetched: Fetched[] = [];
    const onFinished = (req: PwRequest) => {
      void (async () => {
        const sizes = await req.sizes();
        const timing = req.timing();
        const response = await req.response();
        pageFetched.push({
          who: "page",
          url: req.url(),
          encodedBytes: sizes.responseBodySize + sizes.responseHeadersSize,
          encoding: (await response?.headerValue("content-encoding")) ?? "",
          sentAt: timing.startTime,
          finishedAt: timing.startTime + timing.responseEnd,
        });
      })();
    };
    page.on("requestfinished", onFinished);
    const problems: string[] = [];
    page.on("requestfailed", (req) =>
      problems.push(
        `request failed: ${short(req.url())} — ${req.failure()?.errorText ?? "?"}`,
      ),
    );
    page.on("pageerror", (err) =>
      problems.push(`page error: ${err.message.slice(0, 400)}`),
    );
    let bootLine: string | null = null;
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.startsWith("[demo-scope]") && text.includes("host ready"))
        bootLine = text;
      if (msg.type() === "error")
        problems.push(`console error: ${text.slice(0, 600)}`);
    });

    const navAt = Date.now();
    await page.goto(url, { waitUntil: "load" });
    const gate = page.locator(ENTER_DEMO).first();
    await gate.waitFor({ timeout: 120_000 });
    // The homepage settled: what it fetched is not the click's.
    await page.waitForTimeout(1500);
    const downAtClick = shaper?.downBytes() ?? 0;
    const clickAt = Date.now();
    await gate.click();
    // Usable: the boot screen gone (the host ready, the app mounted in the
    // embed), then no loader left on the page.
    await page
      .locator("[data-demo-boot]")
      .first()
      .waitFor({ state: "detached", timeout: USABLE_TIMEOUT_MS });
    const bootGoneAt = Date.now();
    await waitForNotBusy(page, { timeoutMs: USABLE_TIMEOUT_MS });
    const usableAt = Date.now();
    const downAtUsable = shaper?.downBytes() ?? 0;
    // What still arrives right after (a late chunk, an image).
    await page.waitForTimeout(3000);
    for (const p of problems.slice(0, 15)) console.log(`  ! ${p}`);
    if (problems.length > 15) console.log(`  ! … ${problems.length - 15} more`);
    const shot = `${OUT}-${PROFILE}-run${run}.png`;
    await page.screenshot({ path: shot });
    console.log(`screenshot: ${shot}`);

    const workerFetched: Fetched[] = tap.requests
      .filter((q) => q.encodedBytes !== undefined)
      .map((q) => ({
        who: "worker",
        url: q.url,
        encodedBytes: q.encodedBytes!,
        encoding: q.contentEncoding ?? "",
        sentAt: q.sentAt!,
        finishedAt: q.finishedAt!,
      }));
    const afterClick = [...pageFetched, ...workerFetched].filter(
      (f) => f.sentAt >= clickAt - 50 && f.finishedAt <= usableAt + 50,
    );
    const total = afterClick.reduce((s, f) => s + f.encodedBytes, 0);
    console.log(
      `\n── run ${run}/${RUNS} · ${PROFILE}${shape === null ? "" : ` (${shape.downKbps / 1000} Mbps down, ${shape.rttMs} ms RTT)`} · ${url}`,
    );
    console.log(
      `homepage gate shown at ${clickAt - navAt - 1500} ms; click → boot screen gone ${bootGoneAt - clickAt} ms → no loader left ${usableAt - clickAt} ms`,
    );
    console.log(
      `bytes click → usable: ${mb(total)} in ${afterClick.length} requests (CDP)` +
        (shaper === null
          ? ""
          : `; proxy delivered ${mb(downAtUsable - downAtClick)} (TLS)`),
    );
    console.log(
      bootLine === null
        ? "boot line: (none seen)"
        : `boot line: ${String(bootLine)}`,
    );
    const byKind = new Map<string, { bytes: number; n: number }>();
    for (const f of afterClick) {
      const k = `${f.who}: ${kindOf(f.url)}`;
      const e = byKind.get(k) ?? { bytes: 0, n: 0 };
      e.bytes += f.encodedBytes;
      e.n += 1;
      byKind.set(k, e);
    }
    console.log("by kind:");
    for (const [k, e] of [...byKind].sort((a, b) => b[1].bytes - a[1].bytes))
      console.log(
        `  ${k.padEnd(34)} ${mb(e.bytes).padStart(9)}  ${String(e.n).padStart(4)} files`,
      );
    console.log(
      `largest ${TOP} files (wire bytes, encoding, sent → done after click):`,
    );
    for (const f of afterClick
      .toSorted((a, b) => b.encodedBytes - a.encodedBytes)
      .slice(0, TOP))
      console.log(
        `  ${kb(f.encodedBytes).padStart(8)}  ${(f.encoding || "identity").padEnd(8)} ${String(Math.round(f.sentAt - clickAt)).padStart(6)} → ${String(Math.round(f.finishedAt - clickAt)).padStart(6)} ms  ${f.who} ${short(f.url)}`,
      );
    const uncompressed = afterClick.filter(
      (f) => f.encoding === "" && f.encodedBytes > 20 * 1024,
    );
    console.log(
      `sent uncompressed (> 20 KB): ${uncompressed.length} files, ${mb(uncompressed.reduce((s, f) => s + f.encodedBytes, 0))}`,
    );
    r.ok(
      `run ${run}: the demo became usable`,
      true,
      `${usableAt - clickAt} ms`,
    );
    page.off("requestfinished", onFinished);
    await tap.stop();
    await context.close();
    await shaper?.close();
  }
  await r.finish();
});
