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
 * Each connection holds at most a receive window (`--window`, 512 KB) on the
 * link that the browser has not read: a response the browser stops reading
 * (a video once it has its metadata) stops crossing the link, as over TCP
 * (the window counts bytes handed to the local socket, so the loopback
 * buffers add a few hundred KB to it). Without it (`--window 0`) the proxy
 * pulled whole responses at once and charged the link for bytes the browser
 * never read — the hero film put ~13 s of phantom traffic ahead of Enter on
 * fast 4G.
 * `--profile desktop` runs unshaped. CPU is not throttled: the boot stages are
 * this machine's.
 *
 * The visitor clicks `--click-after` ms (1500) after the gate shows.
 *
 * What it prints, per run: the click → usable time, what the link carried
 * before the click and was still busy with at it, what the homepage had in
 * flight then (the downloads the demo's compete with), the host's boot line
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
 *     --url https://equin.ai [--profile desktop|fast4g|slow4g] [--runs 1] [--visits 1] [--top 25]
 *     [--click-after <ms>] [--window <KB>] [--out <prefix>] [--no-record]
 *
 * `--visits N` repeats the visit N times in the same page (about:blank, then
 * the homepage loaded again, Enter clicked again): from the 2nd on, a returning visitor — the
 * demo's data already stored in the browser, the HTTP cache warm. Each visit
 * is measured from its own click.
 */
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
import { PROFILES, startShaper } from "./internal/shaper";

const PROFILE = arg("profile") ?? "fast4g";
const RUNS = numArg("runs", 1);
const TOP = numArg("top", 25);
const OUT = arg("out") ?? "/tmp/enter-cost";
/** Visits per run, in the same page: the 2nd on is a returning visitor (the demo's data stored, the HTTP cache warm). */
const VISITS = numArg("visits", 1);
const USABLE_TIMEOUT_MS = numArg("timeout", 300_000);
/** How long after the gate shows the visitor clicks Enter, ms (`--click-after`). */
const CLICK_AFTER_MS = numArg("click-after", 1500);
/** A tunnel's receive window on the shaped link, bytes (`--window <KB>`; 0: none). */
const WINDOW = numArg("window", 512) * 1024;

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
    const shaper = shape === null ? null : await startShaper(shape, WINDOW);
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

    for (let visit = 1; visit <= VISITS; visit++) {
      // A returning visitor comes from elsewhere; what the previous visit's
      // page aborted as it left is not this visit's.
      if (visit > 1) await page.goto("about:blank");
      problems.length = 0;
      bootLine = null;
      const navAt = Date.now();
      await page.goto(url, { waitUntil: "load" });
      const gate = page.locator(ENTER_DEMO).first();
      await gate.waitFor({ timeout: 120_000 });
      const gateAt = Date.now();
      // The visitor reads a moment, then clicks: what the homepage still
      // fetches then competes with the click's downloads (in flight, below).
      await page.waitForTimeout(CLICK_AFTER_MS);
      const downAtClick = shaper?.downBytes() ?? 0;
      const backlogAtClick = shaper?.backlogMs() ?? 0;
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
      if (problems.length > 15)
        console.log(`  ! … ${problems.length - 15} more`);
      const shot = `${OUT}-${PROFILE}-run${run}${VISITS === 1 ? "" : `-visit${visit}`}.png`;
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
      // What the demo still fetched in the 3 s after usable: code moved past
      // the mark is not code saved.
      const late = [...pageFetched, ...workerFetched].filter(
        (f) => f.sentAt >= clickAt - 50 && f.finishedAt > usableAt + 50,
      );
      console.log(
        `\n── run ${run}/${RUNS}${VISITS === 1 ? "" : ` · visit ${visit}/${VISITS}`} · ${PROFILE}${shape === null ? "" : ` (${shape.downKbps / 1000} Mbps down, ${shape.rttMs} ms RTT)`} · ${url}`,
      );
      console.log(
        `homepage gate shown at ${gateAt - navAt} ms, clicked ${clickAt - gateAt} ms later; click → boot screen gone ${bootGoneAt - clickAt} ms → no loader left ${usableAt - clickAt} ms`,
      );
      console.log(
        `bytes click → usable: ${mb(total)} in ${afterClick.length} requests (CDP)` +
          (shaper === null
            ? ""
            : `; proxy delivered ${mb(downAtUsable - downAtClick)}`),
      );
      console.log(
        `then, within 3 s of usable: ${mb(late.reduce((s, f) => s + f.encodedBytes, 0))} in ${late.length} requests`,
      );
      if (shaper !== null) {
        // The link's own view: what it carried before the click, what it was
        // still busy with at it, and what it carried while the visitor
        // waited — by what each byte answered.
        const largest = (from: number, to: number) =>
          [...shaper.deliveredBetween(from, to)].toSorted(
            (a, b) => b[1] - a[1],
          );
        const line = ([label, bytes]: [string, number]) =>
          `  ${kb(bytes).padStart(8)}  ${label.replace(/^\/artifacts\/[^/]+\//, "…/")}`;
        const before = largest(navAt, clickAt);
        console.log(
          `link before the click: ${mb(before.reduce((t, [, b]) => t + b, 0))}, largest:`,
        );
        for (const e of before.slice(0, 5)) console.log(line(e));
        console.log(
          `link at the click: busy ${(backlogAtClick / 1000).toFixed(1)} s more with what it held; carried click → usable, largest:`,
        );
        for (const e of largest(clickAt, usableAt).slice(0, 8))
          console.log(line(e));
      }
      // What the homepage asked for before the click and was still receiving
      // after it: the downloads the demo's share of the link competes with.
      const inFlight = [...pageFetched, ...workerFetched].filter(
        (f) =>
          f.sentAt >= navAt &&
          f.sentAt < clickAt - 50 &&
          f.finishedAt > clickAt,
      );
      console.log(
        `in flight at the click (sent before it, done after): ${mb(inFlight.reduce((s, f) => s + f.encodedBytes, 0))} in ${inFlight.length} requests`,
      );
      for (const f of inFlight
        .toSorted((a, b) => b.encodedBytes - a.encodedBytes)
        .slice(0, 10))
        console.log(
          `  ${kb(f.encodedBytes).padStart(8)}  ${String(Math.round(f.sentAt - clickAt)).padStart(6)} → ${String(Math.round(f.finishedAt - clickAt)).padStart(6)} ms  ${f.who} ${short(f.url)}`,
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
        `run ${run}${VISITS === 1 ? "" : ` visit ${visit}`}: the demo became usable`,
        true,
        `${usableAt - clickAt} ms`,
      );
    }
    page.off("requestfinished", onFinished);
    await tap.stop();
    await context.close();
    await shaper?.close();
  }
  await r.finish();
});
