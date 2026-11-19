/**
 * What opening something inside the demo costs: one click in the running
 * demo, profiled. Boots the demo at a place (`--at`, an app-rooted location),
 * throttles the page's CPU (`--throttle`, default 4× — what the site's
 * slow-interaction reports see on an ordinary laptop), then clicks the
 * embed's element whose text is `--click` and measures:
 *
 *  - the interaction as the site reports it: the longest Event Timing entry
 *    of the click (input delay, processing, presentation delay);
 *  - the long animation frames from the click on, with their scripts;
 *  - a V8 CPU profile of the page and of the demo's SharedWorker host from
 *    the click until `--settle` ms after it, summarized per function and per
 *    file (and written as `.cpuprofile` with `--out`).
 *
 * Only the page is throttled: CDP cannot throttle a SharedWorker, so the
 * demo's server answers at this machine's full speed — read the worker's
 * profile for its share.
 *
 * Runs the click `--runs` times, each in a fresh context (a cold first open:
 * the on-demand plugins not loaded yet, the worker's reads not cached).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/website/plugins/landing/plugins/screenshot/e2e/open-profile.ts \
 *     --at /agents --click "Sum up last week's pushes" [--throttle 4] [--settle 4000] [--runs 1] [--top 25] [--out <dir>]
 *   ./equin run …/open-profile.ts --at /desktop/home --click Isle
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { CDPSession } from "playwright";
import {
  arg,
  flag,
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { bootDemo, demoPath, embedRoot } from "./internal/demo-pages";

const USAGE =
  "open-profile.ts --at <location> --click <text> [--throttle 4] [--settle 4000] [--runs 1] [--top 25] [--no-profile] [--out <dir>]";
const AT = requireArg("at", USAGE);
const CLICK = requireArg("click", USAGE);
const THROTTLE = numArg("throttle", 4);
const SETTLE_MS = numArg("settle", 4000);
const RUNS = numArg("runs", 1);
const TOP = numArg("top", 25);
const OUT = arg("out");
// `--no-profile`: measure only — a CDP profiler slows what it samples.
const PROFILE = !flag("no-profile");

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

function shortUrl(url: string): string {
  if (url === "") return "(native)";
  const path = new URL(url, "http://x").pathname;
  const m = /\/artifacts\/([^/]+)\/([^/]+)$/.exec(path);
  return m === null ? path : `${m[1]}/${m[2]}`;
}

/** Self and total (inclusive) time per function, from the sample deltas. */
function summarize(label: string, p: CpuProfile): string[] {
  const byNode = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes)
    for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const byFile = new Map<string, number>();
  let busy = 0;
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  const name = (n: ProfileNode) =>
    `${n.callFrame.functionName || "(anonymous)"} ${shortUrl(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
  for (let i = 0; i < samples.length; i++) {
    const ms = (deltas[i + 1] ?? 0) / 1000;
    const leaf = byNode.get(samples[i]!)!;
    const leafName = name(leaf);
    if (leaf.callFrame.functionName === "(idle)") continue;
    busy += ms;
    self.set(leafName, (self.get(leafName) ?? 0) + ms);
    const file = shortUrl(leaf.callFrame.url);
    byFile.set(file, (byFile.get(file) ?? 0) + ms);
    const seen = new Set<string>();
    for (
      let id: number | undefined = leaf.id;
      id !== undefined;
      id = parent.get(id)
    ) {
      const k = name(byNode.get(id)!);
      if (seen.has(k)) continue;
      seen.add(k);
      total.set(k, (total.get(k) ?? 0) + ms);
    }
  }
  const top = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([k, ms]) => `    ${ms.toFixed(1).padStart(8)} ms  ${k}`);
  return [
    `${label}: ${((p.endTime - p.startTime) / 1000).toFixed(0)} ms profiled, ${busy.toFixed(0)} ms busy`,
    "  top functions (self):",
    ...top(self),
    "  top functions (total):",
    ...top(total),
    "  top files (self):",
    ...top(byFile),
  ];
}

/** CDP calls into an attached (non-flat) worker session. */
function workerCaller(cdp: CDPSession, sessionId: string) {
  let next = 1;
  const waiting = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();
  cdp.on(
    "Target.receivedMessageFromTarget",
    (e: { sessionId: string; message: string }) => {
      if (e.sessionId !== sessionId) return;
      const msg = JSON.parse(e.message) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return;
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error !== undefined)
        w?.reject(new Error(`worker CDP ${msg.id}: ${msg.error.message}`));
      else w?.resolve(msg.result);
    },
  );
  return (method: string, params: object = {}): Promise<unknown> => {
    const id = next++;
    const answered = new Promise<unknown>((resolve, reject) =>
      waiting.set(id, { resolve, reject }),
    );
    void cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    return answered;
  };
}

interface Measured {
  /** performance.now() of the click's pointerdown. */
  clickAt: number | null;
  interaction: {
    name: string;
    duration: number;
    inputDelay: number;
    processing: number;
    presentation: number;
  } | null;
  frames: {
    start: number;
    duration: number;
    blocking: number;
    scripts: { invoker: string; fn: string; src: string; duration: number }[];
  }[];
}

await withBrowser(async (h) => {
  const r = report(`demo: profile of clicking "${CLICK}" at ${AT}`);
  for (let run = 0; run < RUNS; run++) {
    const { page } = await h.session();
    const url = pathUrl(demoPath(AT));
    const target = embedRoot(page).getByText(CLICK, { exact: false }).first();

    const browserCdp = await h.browser.newBrowserCDPSession();
    // Set once CDP reaches the worker (a callback TS cannot follow: a holder, not a let).
    const worker: {
      call: ((m: string, p?: object) => Promise<unknown>) | null;
    } = {
      call: null,
    };
    browserCdp.on(
      "Target.targetCreated",
      ({
        targetInfo,
      }: {
        targetInfo: { targetId: string; type: string; url: string };
      }) => {
        if (
          targetInfo.type !== "shared_worker" ||
          !targetInfo.url.includes("/worker-tree.") ||
          worker.call !== null
        )
          return;
        void (async () => {
          const { sessionId } = await browserCdp.send("Target.attachToTarget", {
            targetId: targetInfo.targetId,
            flatten: false,
          });
          const call = workerCaller(browserCdp, sessionId);
          await call("Profiler.enable");
          await call("Profiler.setSamplingInterval", { interval: 200 });
          worker.call = call;
        })();
      },
    );
    await browserCdp.send("Target.setDiscoverTargets", { discover: true });

    await bootDemo(page, url, { marker: `[data-app-embed] :text("${CLICK}")` });
    await target.waitFor({ timeout: 30_000 });
    // Let the boot's own work settle before the click.
    await page.waitForTimeout(3000);

    const pageCdp = await page.context().newCDPSession(page);
    await pageCdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    await pageCdp.send("Profiler.enable");
    await pageCdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await page.evaluate(() => {
      const w = window as unknown as { __open: Measured };
      w.__open = { clickAt: null, interaction: null, frames: [] };
      // The click's own pointerdown, at dispatch: every time below is from it.
      addEventListener(
        "pointerdown",
        () => {
          w.__open.clickAt ??= performance.now();
        },
        { capture: true },
      );
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          const at = w.__open.clickAt;
          // The click's own entries (pointerdown → click), not a hover;
          // an entry's start is the input's timestamp, before its dispatch.
          if (at === null || e.startTime + e.duration < at) continue;
          if (!/^(pointerdown|pointerup|mousedown|mouseup|click)$/.test(e.name))
            continue;
          if (
            w.__open.interaction !== null &&
            w.__open.interaction.duration >= e.duration
          )
            continue;
          w.__open.interaction = {
            name: e.name,
            duration: e.duration,
            inputDelay: e.processingStart - e.startTime,
            processing: e.processingEnd - e.processingStart,
            presentation: e.startTime + e.duration - e.processingEnd,
          };
        }
      }).observe({
        type: "event",
        durationThreshold: 16,
        buffered: false,
      } as PerformanceObserverInit);
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as {
          startTime: number;
          duration: number;
          blockingDuration: number;
          scripts: {
            invoker: string;
            sourceFunctionName: string;
            sourceURL: string;
            duration: number;
          }[];
        }[]) {
          const at = w.__open.clickAt;
          if (at === null || e.startTime + e.duration < at) continue;
          w.__open.frames.push({
            start: Math.round(e.startTime - at),
            duration: Math.round(e.duration),
            blocking: Math.round(e.blockingDuration),
            scripts: e.scripts.map((s) => ({
              invoker: s.invoker,
              fn: s.sourceFunctionName,
              src: s.sourceURL.split("/artifacts/")[1] ?? s.sourceURL,
              duration: Math.round(s.duration),
            })),
          });
        }
      }).observe({ type: "long-animation-frame", buffered: false });
    });
    if (PROFILE) {
      await pageCdp.send("Profiler.start");
      if (worker.call !== null) await worker.call("Profiler.start");
    }
    await target.click();
    await page.waitForTimeout(SETTLE_MS);
    const pageProfile = PROFILE
      ? ((await pageCdp.send("Profiler.stop")) as { profile: CpuProfile })
          .profile
      : null;
    const workerProfile =
      worker.call === null || !PROFILE
        ? null
        : ((await worker.call("Profiler.stop")) as { profile: CpuProfile })
            .profile;
    await pageCdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const m = await page.evaluate(
      () => (window as unknown as { __open: Measured }).__open,
    );
    const i = m.interaction;
    console.info(
      `run ${run + 1}: landed ${page.url()}\n  interaction: ${
        i === null
          ? "none ≥16 ms"
          : `${i.name} ${Math.round(i.duration)} ms (input ${Math.round(i.inputDelay)}, processing ${Math.round(i.processing)}, presentation ${Math.round(i.presentation)})`
      }`,
    );
    const blocking = m.frames.reduce((a, f) => a + f.blocking, 0);
    const busy = m.frames.filter((f) => f.blocking > 0);
    const last = busy.at(-1);
    console.info(
      `  long frames after the click: ${m.frames.length}, blocking ${blocking} ms in total, the last blocking one ending at +${last === undefined ? 0 : last.start + last.duration} ms`,
    );
    console.info(
      "  long animation frames (+ms from the click, duration, blocking):",
    );
    for (const f of m.frames) {
      console.info(`    +${f.start} ${f.duration} ms (blocking ${f.blocking})`);
      for (const s of f.scripts)
        console.info(
          `      ${String(s.duration).padStart(5)} ms  ${s.invoker} → ${s.fn} ${s.src}`,
        );
    }
    if (pageProfile !== null)
      for (const line of summarize("page", pageProfile)) console.info(line);
    if (workerProfile !== null)
      for (const line of summarize("worker", workerProfile)) console.info(line);
    else console.info("worker: not attached");
    if (OUT !== undefined) {
      mkdirSync(OUT, { recursive: true });
      if (pageProfile !== null)
        writeFileSync(
          `${OUT}/page-${run + 1}.cpuprofile`,
          JSON.stringify(pageProfile),
        );
      if (workerProfile !== null)
        writeFileSync(
          `${OUT}/worker-${run + 1}.cpuprofile`,
          JSON.stringify(workerProfile),
        );
    }
    r.ok(
      `run ${run + 1}: measured`,
      i !== null,
      i === null ? "no interaction" : `${Math.round(i.duration)} ms`,
    );
    await browserCdp.detach();
  }
  await r.finish();
});
