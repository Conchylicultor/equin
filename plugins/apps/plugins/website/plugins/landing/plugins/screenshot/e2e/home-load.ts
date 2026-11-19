/**
 * What a first-time visitor's phone pays to see the homepage, before they
 * click anything: first contentful paint, largest contentful paint, total
 * blocking time and time to interactive, the bytes and requests, and what
 * stood between the navigation and the first paint.
 *
 * The phone is an emulated mid-range one (Lighthouse's Moto G Power: 412×823
 * CSS px at 1.75×, touch, a mobile UA) with its CPU slowed 4× by Chrome's
 * own throttling (CDP `Emulation.setCPUThrottlingRate`). The network is the
 * shaped link enter-cost uses (`internal/shaper.ts`: a CONNECT proxy, a token
 * bucket per direction, a receive window per connection), never DevTools
 * network throttling.
 *
 * Each run is a fresh browser context (empty HTTP cache, no storage): visit 1
 * is the cold load; visits 2… reload the homepage in the same context (from
 * about:blank) — a returning visitor, the HTTP cache warm.
 *
 * Metrics, measured in the page by observers installed before navigation:
 * - FCP: `first-contentful-paint`.
 * - LCP: the last `largest-contentful-paint` entry (with the element / URL).
 * - TTI (Lighthouse's definition): the end of the last long task before the
 *   first 5 s window after FCP with no long task and at most 2 requests in
 *   flight (FCP itself when there is no long task).
 * - TBT: the sum over long tasks between FCP and TTI of their time past 50 ms.
 * Bytes are CDP's `encodedDataLength` per finished request (headers + body as
 * sent), until TTI + 5 s; the proxy's own count of what crossed the link is
 * printed beside them.
 *
 * "Before first paint" lists every request that finished before FCP, in the
 * order it started (the critical chain an SPA paints after), with Chrome's
 * `renderBlockingStatus` for the ones the parser held the paint on.
 *
 * `--cpu-profile` samples the main thread and prints its self time per script
 * (a route chunk by its `chunk.<hash>`) before FCP and from FCP to TTI.
 * `--block <text>` aborts every request whose URL contains the text, to
 * measure a load without it (the hero film: `--block .mp4`); Playwright
 * routing turns the HTTP cache off, so a blocked run's repeat visit is
 * another cold one.
 *
 * `--coverage` adds one more cold load (same phone, link and CPU; its times
 * are not reported — coverage slows the page) under V8 precise coverage,
 * taken the frame first paint lands in (the page shows nothing before all
 * its early code ran, then all of it at once). The upfront set is every
 * script that finished before first paint; per set it prints the files and
 * their wire bytes, the source modules they hold (each script's source map,
 * first-party vs npm) with their generated size, and how many of those
 * modules ran by first paint: INITIALISED (a route chunk wraps each module in
 * an `__esmMin` init — the init ran) and CALLED (another function of it ran).
 * A module's wire bytes are its share of its script's generated characters
 * times the script's wire bytes — an estimate. Source maps are read over an
 * unshaped context. Also prints, for every run, when the last byte before
 * first paint arrived.
 *
 * Bytes on an HTTPS target: compare CDP's count with the link's. CDP charges
 * a media request only what the media stack read; the link also carries
 * what the HTTP/2 stream window let in that nobody read (how the hero film's
 * open-ended range cost ~6 MB a visit before `rangedBlobResponse` bounded it).
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/website/plugins/landing/plugins/screenshot/e2e/home-load.ts \
 *     --url https://equin.ai [--profile fast4g|slow4g|desktop] [--cpu 4] [--runs 1] [--visits 2]
 *     [--window <KB>] [--path /] [--top 15] [--cpu-profile] [--coverage] [--block <text>] [--out <prefix>] [--no-record]
 */
import type { Browser, CDPSession, Page } from "playwright";
import {
  arg,
  flag,
  isNpmSource,
  modulesOf,
  numArg,
  pathUrl,
  ranModules,
  readScriptMaps,
  report,
  startCoverage,
  takeCoverage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { PROFILES, startShaper } from "./internal/shaper";

const PROFILE = arg("profile") ?? "fast4g";
const CPU = numArg("cpu", 4);
const RUNS = numArg("runs", 1);
const VISITS = numArg("visits", 2);
const TOP = numArg("top", 15);
const OUT = arg("out") ?? "/tmp/home-load";
/** A tunnel's receive window on the shaped link, bytes (`--window <KB>`; 0: none). */
const WINDOW = numArg("window", 512) * 1024;
/** Lighthouse's quiet window for TTI, ms. */
const QUIET_MS = 5000;
/** Give up waiting for a quiet window after this long, ms. */
const TTI_TIMEOUT_MS = numArg("timeout", 90_000);
/** Record a CPU profile per visit and print where the main thread went before FCP (`--cpu-profile`). */
const CPU_PROFILE = flag("cpu-profile");
/** Abort every request whose URL contains this text (`--block <text>`): what a load costs without it. */
const BLOCK = arg("block");
/** One more cold load under V8 coverage: what of the upfront code ran by first paint (`--coverage`). */
const COVERAGE = flag("coverage");

/** Lighthouse's mobile device (Moto G Power). */
const PHONE = {
  viewport: { width: 412, height: 823 },
  deviceScaleFactor: 1.75,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};

interface Req {
  id: string;
  url: string;
  type: string;
  /** Monotonic seconds (CDP clock). */
  sent: number;
  done: number | null;
  bytes: number;
  failed: boolean;
}

/** Every request of the page, by CDP's own clock (seconds), so in-flight counts are exact. */
function tapNetwork(cdp: CDPSession) {
  const reqs = new Map<string, Req>();
  // Worker scripts, by request id: the extra-info event naming one may come
  // before or after its requestWillBeSent, so the id is remembered.
  const workers = new Set<string>();
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.request.url.startsWith("data:") || workers.has(e.requestId)) return;
    // A redirect reuses the id: the hop before it is a request of its own.
    const prev = reqs.get(e.requestId);
    if (prev !== undefined && prev.done === null) prev.done = e.timestamp;
    reqs.set(e.requestId, {
      id: e.requestId,
      url: e.request.url,
      type: e.type ?? "Other",
      sent: e.timestamp,
      done: null,
      bytes: 0,
      failed: false,
    });
  });
  // A worker's own script never reports loadingFinished on the page's
  // session, so it would read as in flight forever: a worker script is the
  // worker's code, not a page load, and leaves the log (sec-fetch-dest).
  cdp.on("Network.requestWillBeSentExtraInfo", (e) => {
    const dest = Object.entries(e.headers).find(
      ([k]) => k.toLowerCase() === "sec-fetch-dest",
    )?.[1];
    if (
      dest === "worker" ||
      dest === "sharedworker" ||
      dest === "serviceworker"
    ) {
      workers.add(e.requestId);
      reqs.delete(e.requestId);
    }
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (r === undefined) return;
    r.done = e.timestamp;
    r.bytes = e.encodedDataLength;
  });
  cdp.on("Network.loadingFailed", (e) => {
    const r = reqs.get(e.requestId);
    if (r === undefined) return;
    r.done = e.timestamp;
    r.failed = true;
  });
  cdp.on("Network.dataReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (r !== undefined && r.done === null) r.bytes += e.encodedDataLength;
  });
  return reqs;
}

interface InPage {
  /** performance.timeOrigin, ms since the epoch. */
  timeOrigin: number;
  fcp: number | null;
  lcp: { at: number; size: number; what: string } | null;
  longTasks: Array<{ start: number; duration: number }>;
  resources: Array<{
    name: string;
    start: number;
    end: number;
    blocking: string;
    transfer: number;
  }>;
  navResponseEnd: number;
}

type PerfWindow = Window & {
  __home?: {
    lcp: { at: number; size: number; what: string } | null;
    longTasks: Array<{ start: number; duration: number }>;
  };
};

/** Installed before any page script: LCP and long tasks from the first frame. */
function installObservers() {
  const w = window as PerfWindow;
  const acc: NonNullable<PerfWindow["__home"]> = { lcp: null, longTasks: [] };
  w.__home = acc;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const l = e as PerformanceEntry & {
        size: number;
        url: string;
        element: Element | null;
      };
      const el = l.element;
      const what =
        l.url !== ""
          ? l.url
          : el === null
            ? "(removed element)"
            : `<${el.tagName.toLowerCase()}${el.id === "" ? "" : `#${el.id}`}> ${(el.textContent ?? "").trim().slice(0, 60)}`;
      acc.lcp = { at: e.startTime, size: l.size, what };
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      acc.longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: "longtask", buffered: true });
}

async function readPage(page: Page): Promise<InPage> {
  return page.evaluate(() => {
    const w = window as PerfWindow;
    const fcp =
      performance.getEntriesByName("first-contentful-paint")[0]?.startTime ??
      null;
    const nav = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    return {
      timeOrigin: performance.timeOrigin,
      fcp,
      lcp: w.__home?.lcp ?? null,
      longTasks: w.__home?.longTasks ?? [],
      resources: (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      ).map((r) => ({
        name: r.name,
        start: r.startTime,
        end: r.responseEnd,
        blocking:
          (r as PerformanceResourceTiming & { renderBlockingStatus?: string })
            .renderBlockingStatus ?? "?",
        transfer: r.transferSize,
      })),
      navResponseEnd: nav?.responseEnd ?? 0,
    };
  });
}

interface CpuProfile {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }>;
  startTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/**
 * Where the main thread went from navigation to FCP (and FCP to TTI): self
 * time per script (an artifact's path) and the top functions. The profile's
 * clock is CDP's monotonic one in µs, the same as the network log's seconds.
 */
function printCpuProfile(
  profile: CpuProfile,
  nav0: number,
  fcp: number | null,
  tti: number | null,
) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const phases = [
    { name: "nav → FCP", from: 0, to: fcp ?? Infinity },
    { name: "FCP → TTI", from: fcp ?? Infinity, to: tti ?? Infinity },
  ];
  for (const ph of phases) {
    const byUrl = new Map<string, number>();
    const byFn = new Map<string, number>();
    let t = profile.startTime;
    let total = 0;
    for (let i = 0; i < samples.length; i++) {
      t += deltas[i] ?? 0;
      const dt = (deltas[i + 1] ?? 0) / 1000;
      const at = (t / 1e6 - nav0) * 1000;
      if (at < ph.from || at >= ph.to) continue;
      const node = byId.get(samples[i]!);
      if (node === undefined) continue;
      const fn = node.callFrame.functionName || "(anonymous)";
      if (fn === "(idle)" || fn === "(program)") continue;
      total += dt;
      const u =
        node.callFrame.url === "" ? `(${fn})` : short(node.callFrame.url);
      byUrl.set(u, (byUrl.get(u) ?? 0) + dt);
      const key = `${fn} ${node.callFrame.url === "" ? "" : `${short(node.callFrame.url)}:${node.callFrame.lineNumber + 1}`}`;
      byFn.set(key, (byFn.get(key) ?? 0) + dt);
    }
    console.log(`cpu ${ph.name}: ${ms(total)} busy (self time, throttled)`);
    for (const [u, d] of [...byUrl]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, TOP))
      console.log(`  ${ms(d).padStart(8)}  ${u}`);
    console.log(`  top functions:`);
    for (const [f, d] of [...byFn]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, TOP))
      console.log(`  ${ms(d).padStart(8)}  ${f}`);
  }
}

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const ms = (n: number | null) => (n === null ? "—" : `${Math.round(n)} ms`);
const short = (url: string) => {
  const u = new URL(url);
  // A content-addressed chunk is named by its directory (`chunk.<hash>`).
  const p = u.pathname
    .replace(/^\/artifacts\/(chunk\.[0-9a-f]{8})[0-9a-f]*\/index\.js$/, "$1")
    .replace(/^\/artifacts\/[^/]+\//, "…/");
  return p.length > 90 ? `${p.slice(0, 87)}…` : p;
};

/**
 * One cold load under V8 coverage, taken the frame first paint lands in:
 * the upfront set (scripts finished before first paint), its modules, and
 * which of them ran.
 */
async function coveragePass(
  browser: Browser,
  shape: (typeof PROFILES)[string] | null,
  url: string,
): Promise<void> {
  const shaper = shape === null ? null : await startShaper(shape, WINDOW);
  const context = await browser.newContext({
    ...PHONE,
    ...(shaper === null
      ? {}
      : { proxy: { server: `http://127.0.0.1:${shaper.port}` } }),
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  const reqs = tapNetwork(cdp);
  let navMono: number | null = null;
  cdp.on(
    "Network.requestWillBeSent",
    (e: { timestamp: number; type?: string }) => {
      if (navMono === null && e.type === "Document") navMono = e.timestamp;
    },
  );
  await startCoverage(cdp);
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForFunction(
    () => performance.getEntriesByName("first-contentful-paint").length > 0,
    undefined,
    { polling: "raf", timeout: TTI_TIMEOUT_MS },
  );
  const coverage = await takeCoverage(cdp);
  const fcp = await page.evaluate(
    () => performance.getEntriesByName("first-contentful-paint")[0]!.startTime,
  );
  if (navMono === null) throw new Error("no Document request seen");
  const nav0 = navMono as number;
  const upfront = [...reqs.values()].filter(
    (q) =>
      q.type === "Script" &&
      !q.failed &&
      q.done !== null &&
      (q.done - nav0) * 1000 <= fcp,
  );
  await context.close();
  await shaper?.close();

  // The source maps, over an unshaped context of the same origin.
  const reader = await browser.newContext();
  const readerPage = await reader.newPage();
  await readerPage.goto(new URL("/robots.txt", url).href);
  const maps = await readScriptMaps(
    readerPage,
    upfront.map((q) => q.url),
  );
  await reader.close();

  // A module's wire bytes: its share of its script's generated characters.
  const wireOf = new Map(upfront.map((q) => [q.url, q.bytes]));
  const modules = new Map<string, { chars: number; wire: number }>();
  for (const map of maps.values()) {
    const scriptChars = map.text.length;
    const wire = wireOf.get(map.href) ?? 0;
    for (const [src, { chars }] of modulesOf([map])) {
      const e = modules.get(src) ?? { chars: 0, wire: 0 };
      e.chars += chars;
      e.wire += scriptChars === 0 ? 0 : (wire * chars) / scriptChars;
      modules.set(src, e);
    }
  }
  const { initialised, called } = ranModules(coverage, maps);
  const sum = (names: Iterable<string>) => {
    let n = 0;
    let fp = 0;
    let chars = 0;
    let wire = 0;
    let fpWire = 0;
    for (const s of names) {
      const m = modules.get(s);
      if (m === undefined) continue;
      n++;
      chars += m.chars;
      wire += m.wire;
      if (!isNpmSource(s)) {
        fp++;
        fpWire += m.wire;
      }
    }
    return `${n} modules (${fp} ours, ${n - fp} npm), ${kb(chars)} generated, ~${kb(wire)} on the wire (ours ~${kb(fpWire)}, npm ~${kb(wire - fpWire)})`;
  };
  const unmapped = upfront.filter((q) => !maps.has(q.url));
  console.log(
    `\n── coverage at first paint (${Math.round(fcp)} ms, coverage on: not a timing) · ${url}`,
  );
  console.log(
    `upfront set: ${upfront.length} scripts, ${kb(upfront.reduce((t, q) => t + q.bytes, 0))} on the wire; ${maps.size} with a source map` +
      (unmapped.length === 0
        ? ""
        : ` (no map: ${unmapped.map((q) => `${short(q.url)} ${kb(q.bytes)}`).join(", ")})`),
  );
  console.log(`  held:        ${sum(modules.keys())}`);
  console.log(`  initialised: ${sum(initialised)}`);
  console.log(`  called:      ${sum(called)}`);
}

await withBrowser(async (h) => {
  const r = report(`home-load (${PROFILE}, cpu ${CPU}×)`);
  if (!(PROFILE in PROFILES))
    throw new Error(
      `--profile ${PROFILE}: one of ${Object.keys(PROFILES).join(", ")}`,
    );
  const shape = PROFILES[PROFILE] ?? null;
  const url = pathUrl(arg("path") ?? "/");
  for (let run = 1; run <= RUNS; run++) {
    const shaper = shape === null ? null : await startShaper(shape, WINDOW);
    const context = await h.browser.newContext({
      ...PHONE,
      ...(shaper === null
        ? {}
        : { proxy: { server: `http://127.0.0.1:${shaper.port}` } }),
    });
    await context.addInitScript(installObservers);
    if (BLOCK !== undefined)
      await context.route(
        (u) => u.href.includes(BLOCK),
        (route) => route.abort(),
      );
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    if (CPU > 1)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
    const reqs = tapNetwork(cdp);
    const problems: string[] = [];
    page.on("pageerror", (err) =>
      problems.push(`page error: ${err.message.slice(0, 300)}`),
    );

    for (let visit = 1; visit <= VISITS; visit++) {
      if (visit > 1) await page.goto("about:blank");
      reqs.clear();
      problems.length = 0;
      const downBefore = shaper?.downBytes() ?? 0;
      // CDP's clock at the navigation: the requests' timestamps are on it.
      let navMono: number | null = null;
      const onSent = (e: { timestamp: number; type?: string }) => {
        if (navMono === null && e.type === "Document") navMono = e.timestamp;
      };
      cdp.on("Network.requestWillBeSent", onSent);
      if (CPU_PROFILE) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
      }
      await page.goto(url, { waitUntil: "commit" });
      cdp.off("Network.requestWillBeSent", onSent);
      if (navMono === null) throw new Error("no Document request seen");
      const nav0 = navMono as number;

      // Wait for the quiet window: no long task and ≤2 requests in flight for 5 s.
      const started = Date.now();
      let quietSince: number | null = null;
      let snap: InPage = await readPage(page);
      for (;;) {
        await page.waitForTimeout(250);
        snap = await readPage(page);
        const now = (Date.now() - snap.timeOrigin) as number;
        const inFlight = [...reqs.values()].filter(
          (q) => q.done === null,
        ).length;
        const lastLong = snap.longTasks.at(-1);
        const busy =
          snap.fcp === null ||
          inFlight > 2 ||
          (lastLong !== undefined &&
            lastLong.start + lastLong.duration > now - 250);
        if (busy) quietSince = null;
        else quietSince ??= now;
        if (quietSince !== null && now - quietSince >= QUIET_MS) break;
        if (Date.now() - started > TTI_TIMEOUT_MS) {
          problems.push(
            `no quiet ${QUIET_MS} ms window within ${TTI_TIMEOUT_MS} ms`,
          );
          break;
        }
      }
      // TTI: per Lighthouse, the end of the last long task before the quiet
      // window — derived from the long tasks and the request log, both on
      // the page's clock (CDP seconds → ms since navigation start).
      const fcp = snap.fcp;
      const toPage = (mono: number) => (mono - nav0) * 1000;
      const longTasks = snap.longTasks;
      const intervals = [...reqs.values()].map((q) => ({
        start: toPage(q.sent),
        end: q.done === null ? Infinity : toPage(q.done),
      }));
      const inFlightAt = (t: number) =>
        intervals.filter((i) => i.start <= t && i.end > t).length;
      // Lighthouse's TTI: the first instant t ≥ FCP opening a 5 s window
      // with no long task and ≤2 requests in flight; TTI is the end of the
      // last long task before t (FCP when none). A window can open at FCP,
      // a long task's end or a request's end.
      let tti: number | null = null;
      if (fcp !== null) {
        const candidates = [
          fcp,
          ...longTasks.map((t) => t.start + t.duration),
          ...intervals.map((i) => i.end).filter((e) => Number.isFinite(e)),
        ]
          .filter((c) => c >= fcp)
          .toSorted((a, b) => a - b);
        for (const c of candidates) {
          const windowEnd = c + QUIET_MS;
          const taskInside = longTasks.some(
            (t) => t.start + t.duration > c && t.start < windowEnd,
          );
          if (taskInside) continue;
          // In-flight only rises at a request's start: check c and every start inside.
          const edges = [
            c,
            ...intervals
              .map((i) => i.start)
              .filter((e) => e > c && e < windowEnd),
          ];
          if (edges.every((e) => inFlightAt(e) <= 2)) {
            tti = Math.max(
              fcp,
              ...longTasks
                .map((t) => t.start + t.duration)
                .filter((e) => e <= c),
            );
            break;
          }
        }
      }
      const tbt =
        fcp === null
          ? null
          : longTasks
              .filter((t) => t.start >= fcp && (tti === null || t.start < tti))
              .reduce((s, t) => s + Math.max(0, t.duration - 50), 0);
      const all = [...reqs.values()];
      const counted = all.filter(
        (q) => tti === null || toPage(q.sent) < tti + QUIET_MS,
      );
      const bytes = counted.reduce((s, q) => s + q.bytes, 0);
      const shot = `${OUT}-${PROFILE}-run${run}-visit${visit}.png`;
      await page.screenshot({ path: shot });

      console.log(
        `\n── run ${run}/${RUNS} · visit ${visit}/${VISITS} (${visit === 1 ? "cold" : "repeat"}) · ${PROFILE}${shape === null ? "" : ` (${shape.downKbps / 1000} Mbps down, ${shape.rttMs} ms RTT)`} · cpu ${CPU}× · ${url}`,
      );
      for (const p of problems) console.log(`  ! ${p}`);
      console.log(
        `HTML in: ${ms(snap.navResponseEnd)} · FCP ${ms(fcp)} · LCP ${ms(snap.lcp?.at ?? null)} · TTI ${ms(tti)} · TBT ${ms(tbt)} · long tasks ${longTasks.length} (${ms(longTasks.reduce((s, t) => s + t.duration, 0))})`,
      );
      console.log(
        `LCP element: ${snap.lcp?.what ?? "—"} (${snap.lcp?.size ?? 0} px²)`,
      );
      console.log(
        `bytes to TTI+5s: ${kb(bytes)} in ${counted.length} requests (CDP); all so far ${kb(all.reduce((s, q) => s + q.bytes, 0))} in ${all.length}` +
          (shaper === null
            ? ""
            : `; link carried ${kb(shaper.downBytes() - downBefore)}`),
      );
      const byType = new Map<string, { b: number; n: number }>();
      for (const q of counted) {
        const e = byType.get(q.type) ?? { b: 0, n: 0 };
        e.b += q.bytes;
        e.n += 1;
        byType.set(q.type, e);
      }
      console.log(
        `by type: ${[...byType]
          .toSorted((a, b) => b[1].b - a[1].b)
          .map(([t, e]) => `${t} ${kb(e.b)}/${e.n}`)
          .join(" · ")}`,
      );
      if (fcp !== null) {
        const beforeFcp = all
          .filter((q) => q.done !== null && toPage(q.done) <= fcp)
          .toSorted((a, b) => a.sent - b.sent);
        const blocking = new Map(
          snap.resources.map((x) => [x.name, x.blocking]),
        );
        const lastByte = Math.max(0, ...beforeFcp.map((q) => toPage(q.done!)));
        console.log(
          `before first paint: ${beforeFcp.length} requests, ${kb(beforeFcp.reduce((s, q) => s + q.bytes, 0))}; last byte in at ${ms(lastByte)}, first paint ${ms(fcp - lastByte)} after it:`,
        );
        for (const q of beforeFcp.slice(0, 40))
          console.log(
            `  ${String(Math.round(toPage(q.sent))).padStart(6)} → ${String(Math.round(toPage(q.done!))).padStart(6)} ms ${kb(q.bytes).padStart(7)}  ${q.type.padEnd(10)} ${(blocking.get(q.url) ?? "").padEnd(14)} ${short(q.url)}`,
          );
        if (beforeFcp.length > 40)
          console.log(`  … ${beforeFcp.length - 40} more`);
      }
      console.log(`largest ${TOP} requests:`);
      for (const q of counted
        .toSorted((a, b) => b.bytes - a.bytes)
        .slice(0, TOP))
        console.log(
          `  ${kb(q.bytes).padStart(8)}  ${String(Math.round(toPage(q.sent))).padStart(6)} → ${q.done === null ? "  open" : String(Math.round(toPage(q.done))).padStart(6)} ms  ${q.type.padEnd(10)} ${short(q.url)}`,
        );
      const open = all.filter((q) => q.done === null);
      if (open.length > 0)
        console.log(
          `still open at the end: ${open.map((q) => `${q.type} ${short(q.url)} (since ${Math.round(toPage(q.sent))} ms)`).join(", ")}`,
        );
      console.log(
        `long tasks: ${longTasks
          .slice(0, 30)
          .map((t) => `${Math.round(t.start)}+${Math.round(t.duration)}`)
          .join(" ")}`,
      );
      if (CPU_PROFILE) {
        const { profile } = await cdp.send("Profiler.stop");
        printCpuProfile(profile, nav0, fcp, tti);
      }
      console.log(`screenshot: ${shot}`);
      r.ok(
        `run ${run} visit ${visit}: first paint`,
        fcp !== null,
        `FCP ${ms(fcp)} LCP ${ms(snap.lcp?.at ?? null)} TTI ${ms(tti)} TBT ${ms(tbt)}`,
      );
    }
    await context.close();
    await shaper?.close();
  }
  if (COVERAGE) await coveragePass(h.browser, shape, url);
  await r.finish();
});
