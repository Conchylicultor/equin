/**
 * Where a warm reload of the demo spends its CPU: a V8 CPU profile of the
 * page and of the demo's SharedWorker host, from navigation to the Agent
 * Manager shown. In one fresh context it opens `/demo` once (so the data is
 * stored and the assets cached), leaves it for a page outside the demo (the
 * worker ends), then opens it again with both profilers on and prints, per
 * target, the top functions by self time and the top source files.
 *
 * The worker's profiler starts once CDP reaches it (a few ms after it starts):
 * its first module loads are not in the profile — the boot line's `script`
 * stage measures them. `--out <dir>` writes the two `.cpuprofile` files
 * (open them in Chrome DevTools → Performance); `--worker-console` prints
 * what the worker logged.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/profile-reload.ts [--out <dir>] [--top 25] [--worker-console]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { CDPSession } from "playwright";
import {
  arg,
  boot,
  flag,
  numArg,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  demoPath,
  MARKER,
  RENDER_TIMEOUT_MS,
  waitForStorageReleased,
} from "./internal/demo-pages";

const OUT = arg("out");
const TOP = numArg("top", 25);

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** Self time per node id, in ms, from the sample deltas. */
function selfTimes(p: CpuProfile): Map<number, number> {
  const self = new Map<number, number>();
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    // A sample's time is the delta to the NEXT sample.
    const ms = (deltas[i + 1] ?? 0) / 1000;
    self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + ms);
  }
  return self;
}

function shortUrl(url: string): string {
  if (url === "") return "(native)";
  const path = new URL(url, "http://x").pathname;
  // `/artifacts/<plugin-id>.<kind>.<hash>/index.js` → `<plugin-id>.<kind>`
  const m = /\/artifacts\/[^/]*?\/?([^/]+?)(?:\.[0-9a-f]{12,})?\/([^/]+)$/.exec(
    path,
  );
  return m === null ? path : `${m[1]}/${m[2]}`;
}

function summarize(label: string, p: CpuProfile): string[] {
  const self = selfTimes(p);
  const byNode = new Map(p.nodes.map((n) => [n.id, n]));
  const byFn = new Map<string, number>();
  const byFile = new Map<string, number>();
  let total = 0;
  for (const [id, ms] of self) {
    const n = byNode.get(id)!;
    const file = shortUrl(n.callFrame.url);
    const fn = `${n.callFrame.functionName || "(anonymous)"} ${file}:${n.callFrame.lineNumber + 1}`;
    byFn.set(fn, (byFn.get(fn) ?? 0) + ms);
    byFile.set(file, (byFile.get(file) ?? 0) + ms);
    total += ms;
  }
  const top = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([k, ms]) => `    ${ms.toFixed(1).padStart(8)} ms  ${k}`);
  const idle = byFn.get("(idle) (native):0") ?? 0;
  return [
    `${label}: ${((p.endTime - p.startTime) / 1000).toFixed(0)} ms profiled, ${(total - idle).toFixed(0)} ms busy`,
    "  top functions (self):",
    ...top(byFn),
    "  top files (self):",
    ...top(byFile),
  ];
}

/** CDP calls into an attached (non-flat) worker session. */
function workerCaller(
  cdp: CDPSession,
  sessionId: string,
  onConsole: (line: string) => void,
) {
  let next = 1;
  const waiting = new Map<number, (r: unknown) => void>();
  cdp.on(
    "Target.receivedMessageFromTarget",
    (e: { sessionId: string; message: string }) => {
      if (e.sessionId !== sessionId) return;
      const msg = JSON.parse(e.message) as {
        id?: number;
        method?: string;
        params?: { args?: { value?: unknown; description?: string }[] };
        result?: unknown;
        error?: { message: string };
      };
      if (msg.method === "Runtime.consoleAPICalled") {
        onConsole(
          (msg.params?.args ?? [])
            .map((a) => String(a.value ?? a.description ?? ""))
            .join(" "),
        );
        return;
      }
      if (msg.id === undefined) return;
      if (msg.error !== undefined)
        throw new Error(`worker CDP ${msg.id}: ${msg.error.message}`);
      waiting.get(msg.id)?.(msg.result);
      waiting.delete(msg.id);
    },
  );
  return (method: string, params: object = {}): Promise<unknown> => {
    const id = next++;
    const answered = new Promise<unknown>((resolve) =>
      waiting.set(id, resolve),
    );
    void cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    return answered;
  };
}

await withBrowser(async (h) => {
  const r = report("demo: CPU profile of a warm reload");
  const { page } = await h.session();
  const url = pathUrl(demoPath(AGENT_MANAGER_LOCATION));

  // A first visit: the data stored, the assets in the HTTP cache.
  await boot(page, url, { marker: MARKER, timeoutMs: RENDER_TIMEOUT_MS });
  await page.goto(pathUrl("/api/health"));
  await waitForStorageReleased(r, page, "the first visit's worker ended");

  const browserCdp = await h.browser.newBrowserCDPSession();
  /** The worker's console, from when CDP reached it (`--worker-console` prints it). */
  const workerLines: string[] = [];
  const workerConsole = (line: string) => workerLines.push(line);
  let workerCall: ((m: string, p?: object) => Promise<unknown>) | null = null;
  const workerStarted = new Promise<void>((resolve) => {
    browserCdp.on(
      "Target.targetCreated",
      ({
        targetInfo,
      }: {
        targetInfo: { targetId: string; type: string; url: string };
      }) => {
        // The demo's host, not the page's socket worker (also a SharedWorker).
        if (
          targetInfo.type !== "shared_worker" ||
          !targetInfo.url.includes("/worker-tree.") ||
          workerCall !== null
        )
          return;
        void (async () => {
          const { sessionId } = await browserCdp.send("Target.attachToTarget", {
            targetId: targetInfo.targetId,
            flatten: false,
          });
          workerCall = workerCaller(browserCdp, sessionId, workerConsole);
          await workerCall("Runtime.enable");
          await workerCall("Profiler.enable");
          await workerCall("Profiler.setSamplingInterval", { interval: 200 });
          await workerCall("Profiler.start");
          resolve();
        })();
      },
    );
  });
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });

  const pageCdp = await page.context().newCDPSession(page);
  await pageCdp.send("Profiler.enable");
  await pageCdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await pageCdp.send("Profiler.start");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await workerStarted;
  await page
    .locator(MARKER)
    .first()
    .waitFor({ state: "visible", timeout: RENDER_TIMEOUT_MS });
  const paintMs = await page.evaluate(() => performance.now());
  const pageProfile = (
    (await pageCdp.send("Profiler.stop")) as { profile: CpuProfile }
  ).profile;
  const workerProfile = (
    (await workerCall!("Profiler.stop")) as { profile: CpuProfile }
  ).profile;
  console.info(`warm reload: Agent Manager shown at ${Math.round(paintMs)} ms`);
  for (const line of summarize("page", pageProfile)) console.info(line);
  for (const line of summarize("worker", workerProfile)) console.info(line);
  if (flag("worker-console")) {
    console.info("worker console:");
    for (const line of workerLines) console.info(`  ${line}`);
  }
  if (OUT !== undefined) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/page.cpuprofile`, JSON.stringify(pageProfile));
    writeFileSync(`${OUT}/worker.cpuprofile`, JSON.stringify(workerProfile));
    console.info(`profiles written to ${OUT}`);
  }
  r.ok("profiled a warm reload", true);
  await browserCdp.detach();
  await r.finish();
});
