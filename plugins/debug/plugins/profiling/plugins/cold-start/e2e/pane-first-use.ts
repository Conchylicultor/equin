// First use of a LARGE pane whose code has not run yet in this page: the delay
// between asking for the pane (an in-app navigation) and it being drawn, when
// its app's deferred plugin code — and the not-yet-loaded chunks it imports —
// must be fetched and evaluated first. The cost a "load a plugin on first
// use" design (stage 3) would add to every first visit of an app per page.
//
//   ./equin run plugins/debug/plugins/profiling/plugins/cold-start/e2e/pane-first-use.ts \
//     --url http://equin.localhost:<port>/agents [--panes sonata,deploy,places] \
//     [--iterations 5] [--out "$EQUIN_SCRATCH/pane-first-use.json"]
//
// The page is loaded at `--url`'s path (the "from" app, /agents by default)
// and the pane is reached by an in-app navigation (pushState + popstate, the
// way the app's own links route), in a fresh page per run.
//
// Method — today every deferred plugin loads right after first paint, so
// "code not run yet" is produced by STALLING the deferred tier:
//
//   - The served link record (`link.<key>/meta.json` + `modules.json` in the
//     web-artifact store, matched to the page's import map) gives every
//     module's group (boot, an app root, or the `+`-joined app roots sharing
//     it) and chunk. A warm-up load gives the deferred tier's real batches:
//     every `boot-plugin:<path>` measure (boot-trace) of one batch starts at
//     the same instant, since loadPlugins calls a batch's loaders at once.
//   - HELD (the pane's code): the chunks of every group that holds the pane's
//     app root, not the from-app's, and whose earliest app in the deferred
//     order IS the pane's app (a group an earlier app needs is loaded by that
//     app before the pane's batch — not held, its bytes are listed apart).
//   - PARKED (everything after the pane's app): the chunks whose earliest app
//     comes later, so the batches after the pane's do not compete with its
//     render. A plugin of another app sharing a batch with the pane's
//     ("foreign") gets its definition chunk's static closure released with
//     the pane's (it would otherwise hold the batch).
//   - Requests are held with raw CDP `Fetch` (URL patterns on those chunks
//     only). Unlike a Playwright route (which turns the HTTP cache off), raw
//     Fetch interception keeps the cache: continued requests are served from
//     it — checked per run (transferSize 0 with a body), and printed.
//   - The deferred loop stalls at the pane's first batch. Then t0: navigate,
//     and release the held chunks. Measured from t0 (page clock):
//       fetch      — union of the held chunks' Resource Timing intervals
//                    (cache read; one chunk per request)
//       code ready — the last of the pane's plugins' `boot-plugin:` measures
//                    ends (import = fetch + link, then its __esmMin inits run:
//                    the evaluation of its own modules and any boot-chunk
//                    module nothing had initialised yet)
//       pane box   — the pane's `[data-pane-id]` box is in the DOM
//       content    — that box holds its data marker and no aria-busy loader
//       painted    — the next animation frame after content
//     plus the renderer's main-thread script time t0 → painted (CDP
//     Performance metrics, thread ticks).
//   - BASELINE, same flow with nothing held: the deferred tier completes,
//     then the same navigation — the first render of a pane whose code HAS
//     run (today's experience). First-use extra = held − baseline.
//
// Cached case only (the local app): one context whose HTTP and V8 code
// caches two warm-up loads fill (each visits every pane, so lazy chunks are
// cached too). No cold-network figure: shaping the link is not cheap here.
//
// Limits:
//   - The pane's plugins still load in the deferred tier's batches of 24 with
//     a main-thread yield between them (2–3 batches for a big app), not as one
//     on-demand import; foreign plugins sharing those batches are evaluated
//     inside the measured window (counted and printed).
//   - Groups shared with an app earlier in the deferred order are loaded
//     before t0 (bytes printed as "already loaded"); boot-chunk modules the
//     pane initialises are linked already — only their evaluation is counted.
//   - The pane's own plugin definitions that sit in boot chunks evaluate in
//     the stalled batch BEFORE t0 (counted as "pre-evaluated").
//   - Lazy (dynamically imported) chunks a pane loads when it renders are
//     on-demand today too: they are in both runs' render.
//   - Content includes the pane's data subscriptions (same in both runs);
//     "painted" is the next frame, not a paint timing entry.
//   - Wall times move with the machine: the load average is printed per run.
//     `./equin run` lifts an e2e script (and its Chromium) out of the macOS
//     background tier; the tier is printed so a run that was not lifted shows.

import { loadavg } from "node:os";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";
import {
  arg,
  DEFAULT_VIEWPORT,
  detectOsColorScheme,
  numArg,
  pageUrl,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  BOOT_PLUGIN_TIMING_PREFIX,
  BOOT_TIMING_PREFIX,
  DEFERRED_LOAD_COMPLETE_ID,
  ROUTE_CONTENT_COMMIT_ID,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import { webArtifactsDir } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/data-dirs";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { readDarwinBackground } from "@plugins/packages/plugins/spawn-priority/core";

// ── Panes ───────────────────────────────────────────────────────────────────

interface PaneSpec {
  route: string;
  /** The app root its plugins live under (a link group key). */
  root: string;
  paneId: string;
  /** Text its box shows only once its data is drawn. */
  marker: string;
  /** Also wait for a canvas in the box (a map). */
  canvas?: boolean;
}

const PANES: Record<string, PaneSpec> = {
  sonata: {
    route: "/sonata",
    root: "apps/plugins/sonata/",
    paneId: "sonata-library",
    marker: "×",
  },
  deploy: {
    route: "/deploy",
    root: "apps/plugins/deploy/",
    paneId: "deploy-index",
    marker: "last deploy",
  },
  places: {
    route: "/places",
    root: "apps/plugins/places/",
    paneId: "places-map",
    marker: "All places",
    canvas: true,
  },
};

const iterations = numArg("iterations", 5);
const out = arg("out");
const paneNames = (arg("panes") ?? "sonata,deploy,places").split(",");
const fromUrl = pageUrl("/agents");
for (const n of paneNames)
  if (PANES[n] === undefined)
    throw new Error(
      `unknown pane "${n}" (known: ${Object.keys(PANES).join(", ")})`,
    );

const ROUTE_CONTENT = `${BOOT_TIMING_PREFIX}${ROUTE_CONTENT_COMMIT_ID}`;
const DEFERRED_DONE = `${BOOT_TIMING_PREFIX}${DEFERRED_LOAD_COMPLETE_ID}`;

// ── The served link record ──────────────────────────────────────────────────

interface Link {
  dir: string;
  chunkMap: Record<string, string>;
  modules: Record<string, { group: string; chunk: string | null }>;
}

async function servedLink(page: Page): Promise<Link> {
  const served = await page.evaluate(async (href) => {
    const html = await (await fetch(href)).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const map = JSON.parse(
      doc.querySelector("script[type=importmap]")?.textContent ?? "{}",
    ) as { imports?: Record<string, string> };
    const entry = doc
      .querySelector("script[type=module][src]")
      ?.getAttribute("src");
    return { imports: map.imports ?? {}, entry: entry ?? null };
  }, fromUrl);
  if (served.entry === null) throw new Error("the page has no entry module");
  const chunks = Object.entries(served.imports).filter(([k]) =>
    k.startsWith("@chunk/"),
  );
  const store = String(webArtifactsDir.file("store"));
  const hits: string[] = [];
  for (const name of readdirSync(store)) {
    if (!name.startsWith("link.")) continue;
    const metaPath = join(store, name, "meta.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      entryUrl: string;
      chunkMap: Record<string, string>;
    };
    if (meta.entryUrl !== served.entry) continue;
    if (chunks.every(([k, v]) => meta.chunkMap[k] === v)) hits.push(name);
  }
  // Several link records can serve the same import map (the same chunks
  // from differently-addressed artifacts): any will do when they agree on
  // every module's group and chunk — all this script reads.
  const read = (dir: string) =>
    JSON.parse(
      readFileSync(join(store, dir, "modules.json"), "utf8"),
    ) as Link["modules"];
  const signature = (m: Link["modules"]) =>
    [...new Set(Object.values(m).map((v) => `${v.group}\t${v.chunk}`))]
      .sort()
      .join("\n");
  const dir = hits[0];
  if (dir === undefined)
    throw new Error(`no link record in ${store} matches the served import map`);
  const modules = read(dir);
  for (const other of hits.slice(1))
    if (signature(read(other)) !== signature(modules))
      throw new Error(
        `link records ${dir} and ${other} both match the served import map but group modules differently`,
      );
  const meta = JSON.parse(
    readFileSync(join(store, dir, "meta.json"), "utf8"),
  ) as { chunkMap: Record<string, string> };
  return { dir: join(store, dir), chunkMap: meta.chunkMap, modules };
}

function chunkFile(url: string, suffix = ""): string {
  return join(
    String(webArtifactsDir.file("store")),
    url.replace(/^\/artifacts\//, "") + suffix,
  );
}
const fileSize = (p: string) => (existsSync(p) ? statSync(p).size : 0);

/** A chunk's static `@chunk/` imports, followed transitively. */
function staticClosure(link: Link, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  for (let url = stack.pop(); url !== undefined; url = stack.pop()) {
    if (seen.has(url)) continue;
    seen.add(url);
    const text = readFileSync(chunkFile(url), "utf8");
    for (const m of text.matchAll(
      /(?:from|import)\s*["'`](@chunk\/[0-9a-f]+)["'`]/g,
    )) {
      const target = link.chunkMap[m[1] ?? ""];
      if (target !== undefined) stack.push(target);
    }
  }
  return seen;
}

/** `apps/plugins/sonata/plugins/library` → its definition module's chunk. */
function definitionChunk(link: Link, pluginPath: string): string | null {
  const id = pluginPath.split("/plugins/").join(".");
  for (const [k, v] of Object.entries(link.modules))
    if (k.startsWith(`${id}.web.`) && k.endsWith("/__plugin.js"))
      return v.chunk;
  return null;
}

// ── Page probes ─────────────────────────────────────────────────────────────

function waitForMark(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (n) =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list, obs) => {
          const hit = list.getEntries().find((e) => e.name === n);
          if (hit === undefined) return;
          obs.disconnect();
          resolve(hit.startTime);
        }).observe({ type: "mark", buffered: true });
      }),
    name,
  );
}

/** Resolves when the main thread has had an idle period (the page settled). */
function idle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: 5000 });
      }),
  );
}

interface PluginMeasure {
  path: string;
  start: number;
  end: number;
  tier: string;
}

function pluginMeasures(page: Page): Promise<PluginMeasure[]> {
  return page.evaluate((prefix) => {
    return performance
      .getEntriesByType("measure")
      .filter((e) => e.name.startsWith(prefix))
      .map((e) => ({
        path: e.name.slice(prefix.length),
        start: e.startTime,
        end: e.startTime + e.duration,
        tier: String((e as PerformanceMeasure).detail?.tier ?? ""),
      }));
  }, BOOT_PLUGIN_TIMING_PREFIX);
}

async function scriptMs(cdp: CDPSession): Promise<number> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const v = metrics.find((m) => m.name === "ScriptDuration")?.value;
  if (v === undefined) throw new Error("no ScriptDuration metric");
  return v * 1000;
}

/** Arms the pane observer and navigates; returns t0 (page clock). */
function startNavigation(page: Page, pane: PaneSpec): Promise<number> {
  return page.evaluate((p) => {
    const w = window as unknown as {
      __paneFirstUse?: Promise<{
        box: number;
        content: number;
        painted: number;
      }>;
    };
    let box = NaN;
    w.__paneFirstUse = new Promise((resolve) => {
      const check = (obs: MutationObserver) => {
        const el = document.querySelector(`[data-pane-id="${p.paneId}"]`);
        if (el === null) return;
        if (Number.isNaN(box)) box = performance.now();
        if (!(el.textContent ?? "").includes(p.marker)) return;
        if (p.canvas && el.querySelector("canvas") === null) return;
        for (const b of el.querySelectorAll('[aria-busy="true"]'))
          if ((b as HTMLElement).offsetParent !== null) return;
        obs.disconnect();
        const content = performance.now();
        requestAnimationFrame(() => {
          const painted = performance.now();
          resolve({ box, content, painted });
        });
      };
      const obs = new MutationObserver(() => check(obs));
      obs.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-busy"],
      });
    });
    const t0 = performance.now();
    history.pushState({}, "", p.route);
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    return t0;
  }, pane);
}

function awaitPane(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __paneFirstUse?: Promise<{
        box: number;
        content: number;
        painted: number;
      }>;
    };
    if (w.__paneFirstUse === undefined) throw new Error("navigation not armed");
    return w.__paneFirstUse;
  });
}

interface ChunkTiming {
  url: string;
  start: number;
  end: number;
  transfer: number;
  body: number;
  decoded: number;
}

function chunkTimings(page: Page, urls: string[]): Promise<ChunkTiming[]> {
  return page.evaluate((us) => {
    const want = new Set(us.map((u) => new URL(u, location.href).href));
    return (
      performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    )
      .filter((e) => want.has(e.name))
      .map((e) => ({
        url: e.name,
        start: e.startTime,
        end: e.responseEnd,
        transfer: e.transferSize,
        body: e.encodedBodySize,
        decoded: e.decodedBodySize,
      }));
  }, urls);
}

function unionMs(xs: { start: number; end: number }[]): number {
  const s = [...xs].sort((a, b) => a.start - b.start);
  let total = 0;
  let cur: { start: number; end: number } | null = null;
  for (const x of s) {
    if (cur === null || x.start > cur.end) {
      if (cur !== null) total += cur.end - cur.start;
      cur = { ...x };
    } else cur.end = Math.max(cur.end, x.end);
  }
  if (cur !== null) total += cur.end - cur.start;
  return total;
}

/** A bound on a wait the page may never satisfy (a script's own guard, not a fix). */
function bounded<T>(p: Promise<T>, what: string, ms = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)),
      ms,
    );
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Resolves (page clock) once every one of `paths` has its boot-plugin measure. */
function allLoaded(page: Page, paths: string[]): Promise<number> {
  return page.evaluate(
    ({ prefix, want }) =>
      new Promise<number>((resolve) => {
        const left = new Set(want.map((p) => prefix + p));
        let last = 0;
        new PerformanceObserver((list, obs) => {
          for (const e of list.getEntries())
            if (left.delete(e.name))
              last = Math.max(last, e.startTime + e.duration);
          if (left.size > 0) return;
          obs.disconnect();
          resolve(last);
        }).observe({ type: "measure", buffered: true });
      }),
    { prefix: BOOT_PLUGIN_TIMING_PREFIX, want: paths },
  );
}

// ── One run ─────────────────────────────────────────────────────────────────

interface Plan {
  pane: string;
  spec: PaneSpec;
  held: Set<string>;
  parked: Set<string>;
  foreignRelease: Set<string>;
  panePlugins: string[];
  foreignPlugins: string[];
  heldBytes: number;
  heldBrBytes: number;
  heldModules: number;
  sharedEarlier: { bytes: number; modules: number };
}

interface Row {
  loadAvg: number;
  boxMs: number;
  contentMs: number;
  paintedMs: number;
  scriptMs: number;
  fetchMs?: number;
  fetchEndMs?: number;
  codeReadyMs?: number;
  chunks?: number;
  fromCache?: number;
  decodedBytes?: number;
  preEvaluated?: number;
  foreignInWindow?: number;
  /** The pane's plugins loaded by the time it painted, of all of them. */
  paneLoadedAtPaint?: number;
  /** Main-thread script time t0 → code ready. */
  codeScriptMs?: number;
}

type Mode = "baseline" | "first-use" | "load-only";

/**
 * Continue one paused request. A request the page dropped meanwhile (its
 * page closed, the import abandoned) answers "Invalid state" / "Invalid
 * InterceptionId"; one paused just as interception was turned off (Fetch.disable
 * lets every paused request through) answers "Fetch domain is not enabled".
 * Nothing is waiting on either, so those errors are expected.
 */
async function continueRequest(cdp: CDPSession, requestId: string) {
  await cdp
    .send("Fetch.continueRequest", { requestId })
    .catch((err: unknown) => {
      if (
        err instanceof Error &&
        /Invalid (state|InterceptionId)|Fetch domain is not enabled/.test(
          err.message,
        )
      )
        return;
      throw err;
    });
}

async function runOnce(
  context: BrowserContext,
  plan: Plan,
  mode: Mode,
): Promise<Row> {
  const hold = mode !== "baseline";
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  const origin = new URL(fromUrl).origin;
  const paused = new Map<string, string>(); // requestId → path
  const released = new Set<string>(); // paths continued on sight
  let firstHeld: (() => void) | null = null;
  const heldSeen = new Promise<void>((r) => (firstHeld = r));
  const releaseAll = async (paths: Iterable<string>) => {
    for (const u of paths) released.add(u);
    const now = [...paused].filter(([, u]) => released.has(u));
    for (const [id] of now) paused.delete(id);
    await Promise.all(now.map(([id]) => continueRequest(cdp, id)));
  };
  if (hold) {
    cdp.on(
      "Fetch.requestPaused",
      (e: { requestId: string; request: { url: string } }) => {
        const path = new URL(e.request.url).pathname;
        if (released.has(path)) {
          void continueRequest(cdp, e.requestId);
          return;
        }
        paused.set(e.requestId, path);
        if (plan.held.has(path)) firstHeld?.();
      },
    );
    await cdp.send("Fetch.enable", {
      patterns: [...plan.held, ...plan.parked].map((u) => ({
        urlPattern: `${origin}${u}`,
        requestStage: "Request" as const,
      })),
    });
  }
  const loadAvg = loadavg()[0] ?? NaN;
  await page.goto(fromUrl, { waitUntil: "commit" });
  await waitForMark(page, ROUTE_CONTENT);
  if (hold)
    await bounded(heldSeen, "the deferred tier to request a held chunk");
  else await waitForMark(page, DEFERRED_DONE);
  await idle(page);
  if (hold) {
    const done = await page.evaluate(
      (n) => performance.getEntriesByName(n).length > 0,
      DEFERRED_DONE,
    );
    if (done) throw new Error("the deferred tier completed despite the hold");
  }
  const script0 = await scriptMs(cdp);
  const t0 =
    mode === "load-only"
      ? await page.evaluate(() => performance.now())
      : await startNavigation(page, plan.spec);
  if (hold) await releaseAll([...plan.held, ...plan.foreignRelease]);
  // Once every plugin of the pane's app has loaded, the parked rest of the
  // tier is let through: a pane whose content waits for the WHOLE deferred
  // tier (a DataView's saved rule on a field a later plugin may contribute
  // stays pending until deferred-load-complete — Places' list) would
  // otherwise never draw.
  const codeLoaded = hold
    ? allLoaded(page, plan.panePlugins).then(async (end) => {
        const script = await scriptMs(cdp);
        await releaseAll(plan.parked);
        return { end, script };
      })
    : null;
  let row: Row;
  if (mode === "load-only") {
    const loaded = await bounded(
      codeLoaded ?? Promise.reject(new Error("unreachable")),
      `the ${plan.pane} plugins to load`,
    );
    row = {
      loadAvg,
      boxMs: NaN,
      contentMs: NaN,
      paintedMs: NaN,
      scriptMs: loaded.script - script0,
    };
  } else {
    const shown = await bounded(
      awaitPane(page),
      `the ${plan.pane} pane to draw`,
    );
    const script1 = await scriptMs(cdp);
    row = {
      loadAvg,
      boxMs: shown.box - t0,
      contentMs: shown.content - t0,
      paintedMs: shown.painted - t0,
      scriptMs: script1 - script0,
    };
  }
  if (codeLoaded !== null) {
    const loaded = await bounded(
      codeLoaded,
      `the ${plan.pane} plugins to load`,
    );
    const timings = (await chunkTimings(page, [...plan.held])).filter(
      (t) => t.start >= t0 - 1,
    );
    const measures = await pluginMeasures(page);
    const mine = measures.filter(
      (m) => m.tier === "deferred" && m.path.startsWith(plan.spec.root),
    );
    const after = mine.filter((m) => m.end >= t0);
    const windowEnd = Number.isNaN(row.paintedMs)
      ? loaded.end
      : t0 + row.paintedMs;
    row.fetchMs = unionMs(timings);
    row.fetchEndMs = Math.max(...timings.map((t) => t.end)) - t0;
    row.codeReadyMs = loaded.end - t0;
    row.codeScriptMs = loaded.script - script0;
    row.chunks = timings.length;
    row.fromCache = timings.filter(
      (t) => t.transfer === 0 && t.body > 0,
    ).length;
    row.decodedBytes = timings.reduce((s, t) => s + t.decoded, 0);
    row.preEvaluated = mine.length - after.length;
    row.paneLoadedAtPaint = mine.filter((m) => m.end <= windowEnd).length;
    row.foreignInWindow = measures.filter(
      (m) =>
        !m.path.startsWith(plan.spec.root) &&
        m.end >= t0 &&
        m.start <= windowEnd,
    ).length;
    await releaseAll([]);
    await Promise.all([...paused.keys()].map((id) => continueRequest(cdp, id)));
    paused.clear();
    await cdp.send("Fetch.disable");
  }
  await cdp.detach();
  await page.close();
  return row;
}

// ── Plan ────────────────────────────────────────────────────────────────────

async function warmUp(context: BrowserContext): Promise<PluginMeasure[]> {
  const page = await context.newPage();
  await page.goto(fromUrl, { waitUntil: "commit" });
  await waitForMark(page, DEFERRED_DONE);
  await idle(page);
  const measures = await pluginMeasures(page);
  for (const n of paneNames) {
    const spec = PANES[n];
    if (spec === undefined) continue;
    await startNavigation(page, spec);
    await awaitPane(page);
    await idle(page);
  }
  await page.close();
  return measures;
}

function makePlan(
  link: Link,
  measures: PluginMeasure[],
  fromRoot: string | null,
  pane: string,
): Plan {
  const spec = PANES[pane];
  if (spec === undefined) throw new Error(`unknown pane ${pane}`);
  // The deferred tier's batches, in order: one start instant per batch.
  const deferred = measures
    .filter((m) => m.tier === "deferred")
    .sort((a, b) => a.start - b.start);
  const batches: PluginMeasure[][] = [];
  for (const m of deferred) {
    const last = batches.at(-1);
    if (
      last !== undefined &&
      Math.abs((last[0]?.start ?? NaN) - m.start) < 0.01
    )
      last.push(m);
    else batches.push([m]);
  }
  const appOf = (p: string) =>
    /^apps\/plugins\/[^/]+\//.exec(p + "/")?.[0] ?? null;
  const appOrder = new Map<string, number>();
  batches.forEach((b, i) => {
    for (const m of b) {
      const a = appOf(m.path);
      if (a !== null && !appOrder.has(a)) appOrder.set(a, i);
    }
  });
  const paneOrder = appOrder.get(spec.root);
  if (paneOrder === undefined)
    throw new Error(`${spec.root} has no deferred plugin after ${fromUrl}`);
  const earliest = (group: string) =>
    Math.min(...group.split("+").map((r) => appOrder.get(r) ?? Infinity));

  const groupChunks = new Map<string, Set<string>>();
  const groupModules = new Map<string, number>();
  for (const v of Object.values(link.modules)) {
    groupModules.set(v.group, (groupModules.get(v.group) ?? 0) + 1);
    if (v.chunk === null) continue;
    const s = groupChunks.get(v.group) ?? new Set<string>();
    s.add(v.chunk);
    groupChunks.set(v.group, s);
  }
  const held = new Set<string>();
  const parked = new Set<string>();
  let heldModules = 0;
  const sharedEarlier = { bytes: 0, modules: 0 };
  for (const [group, chunks] of groupChunks) {
    if (group === "boot" || group === "lazy") continue;
    const roots = group.split("+");
    if (fromRoot !== null && roots.includes(fromRoot)) continue;
    const first = earliest(group);
    if (roots.includes(spec.root)) {
      if (first === paneOrder) {
        for (const c of chunks) held.add(c);
        heldModules += groupModules.get(group) ?? 0;
      } else {
        sharedEarlier.modules += groupModules.get(group) ?? 0;
        for (const c of chunks) sharedEarlier.bytes += fileSize(chunkFile(c));
      }
    } else if (first > paneOrder) for (const c of chunks) parked.add(c);
  }
  const panePlugins = deferred
    .filter((m) => m.path.startsWith(spec.root))
    .map((m) => m.path);
  const paneBatches = batches.filter((b) =>
    b.some((m) => m.path.startsWith(spec.root)),
  );
  const foreignPlugins = paneBatches
    .flat()
    .filter((m) => !m.path.startsWith(spec.root))
    .map((m) => m.path);
  const defs = foreignPlugins
    .map((p) => definitionChunk(link, p))
    .filter((c): c is string => c !== null);
  const foreignRelease = new Set(
    [...staticClosure(link, defs)].filter((c) => parked.has(c)),
  );
  let heldBytes = 0;
  let heldBrBytes = 0;
  for (const c of held) {
    heldBytes += fileSize(chunkFile(c));
    heldBrBytes += fileSize(chunkFile(c, ".br"));
  }
  return {
    pane,
    spec,
    held,
    parked,
    foreignRelease,
    panePlugins,
    foreignPlugins,
    heldBytes,
    heldBrBytes,
    heldModules,
    sharedEarlier,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

const median = (xs: number[]) => {
  const s = [...xs].filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length === 0 ? NaN : (s[Math.floor((s.length - 1) / 2)] ?? NaN);
};
const fmt = (xs: number[]) =>
  `${Math.round(median(xs))} ms (${Math.round(Math.min(...xs))}–${Math.round(Math.max(...xs))})`;
const kb = (b: number) => `${(b / 1024).toFixed(0)} KB`;

const tier = readDarwinBackground();
console.log(`scheduling tier of this script: ${JSON.stringify(tier)}`);

const results = await withBrowser(async (h) => {
  const context = await h.browser.newContext({
    viewport: { ...DEFAULT_VIEWPORT },
    colorScheme: detectOsColorScheme(),
  });
  // The default Resource Timing buffer (250) drops most chunk entries.
  await context.addInitScript(() =>
    performance.setResourceTimingBufferSize(100_000),
  );
  await warmUp(context);
  const measures = await warmUp(context);
  const probe = await context.newPage();
  await probe.goto(pathUrl("/"), { waitUntil: "commit" });
  const link = await servedLink(probe);
  await probe.close();
  const priority = measures.find((m) => m.tier === "priority");
  const fromRoot =
    priority === undefined
      ? null
      : (/^apps\/plugins\/[^/]+\//.exec(priority.path + "/")?.[0] ?? null);
  console.log(
    `from ${fromUrl} (active app ${fromRoot ?? "none"}); link ${link.dir}`,
  );

  const out: Record<
    string,
    {
      plan: Plan;
      baseline: Row[];
      held: Row[];
      loadOnly: Row[];
      failed: string[];
    }
  > = {};
  for (const n of paneNames) {
    const plan = makePlan(link, measures, fromRoot, n);
    out[n] = { plan, baseline: [], held: [], loadOnly: [], failed: [] };
    console.log(
      `${n}: ${plan.panePlugins.length} deferred plugins; held ${plan.held.size} chunks ` +
        `(${kb(plan.heldBytes)} min, ${kb(plan.heldBrBytes)} br, ${plan.heldModules} modules); ` +
        `shared with an earlier app ${kb(plan.sharedEarlier.bytes)} / ${plan.sharedEarlier.modules} modules; ` +
        `parked ${plan.parked.size} later chunks; ${plan.foreignPlugins.length} foreign plugins in its batches ` +
        `(${plan.foreignRelease.size} parked chunks released with it)`,
    );
  }
  for (let i = 0; i < iterations; i++) {
    for (const n of paneNames) {
      const r = out[n];
      if (r === undefined) continue;
      // A run that fails (the page navigated away, a bound ran out) is
      // printed and counted, and the pane's other runs go on.
      const attempt = async (
        mode: Mode,
      ): Promise<{ ok: true; row: Row } | { ok: false; error: string }> => {
        try {
          return { ok: true, row: await runOnce(context, r.plan, mode) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  #${i + 1} ${n} ${mode} run FAILED: ${msg}`);
          r.failed.push(`${mode}: ${msg}`);
          for (const pg of context.pages()) await pg.close();
          return { ok: false, error: msg };
        }
      };
      const ran = async (mode: Mode) => {
        const a = await attempt(mode);
        return a.ok ? a.row : undefined;
      };
      const base = await ran("baseline");
      const held = await ran("first-use");
      const only = await ran("load-only");
      if (base !== undefined) r.baseline.push(base);
      if (held !== undefined) r.held.push(held);
      if (only !== undefined) r.loadOnly.push(only);
      const ms = (x: number | undefined) => Math.round(x ?? NaN);
      console.log(
        `  #${i + 1} ${n} load ${loadavg()[0]?.toFixed(1)}: ` +
          `baseline painted ${ms(base?.paintedMs)} (script ${ms(base?.scriptMs)}); ` +
          `first use painted ${ms(held?.paintedMs)} (script ${ms(held?.scriptMs)}), code ready ${ms(held?.codeReadyMs)}, ` +
          `box ${ms(held?.boxMs)}, content ${ms(held?.contentMs)}, plugins loaded at paint ${held?.paneLoadedAtPaint}/${r.plan.panePlugins.length}, foreign ${held?.foreignInWindow}; ` +
          `load only: code ready ${ms(only?.codeReadyMs)} (script ${ms(only?.codeScriptMs)}), fetch ${ms(only?.fetchMs)} over ${only?.chunks} chunks ` +
          `(${only?.fromCache} from cache, ${kb(only?.decodedBytes ?? 0)}), last read ${ms(only?.fetchEndMs)}, pre-evaluated ${only?.preEvaluated}, foreign ${only?.foreignInWindow}`,
      );
    }
  }
  await context.close();
  return out;
});

console.log(
  `\n=== first use of a pane, cached — median (min–max) over ${iterations} ===`,
);
const row = (label: string, xs: number[]) =>
  console.log(`  ${label.padEnd(44)} ${fmt(xs)}`);
for (const [n, r] of Object.entries(results)) {
  const { plan, baseline: b, held: x, loadOnly: l, failed } = r;
  console.log(
    `\n${n} (${plan.spec.route}) — ${plan.panePlugins.length} plugins, held ${plan.held.size} chunks ${kb(plan.heldBytes)} (${kb(plan.heldBrBytes)} br), ${plan.heldModules} modules`,
  );
  if (failed.length > 0)
    console.log(`  ${failed.length} failed run(s): ${failed.join(" | ")}`);
  row(
    "LOAD ONLY  fetch (union of chunk reads)",
    l.map((y) => y.fetchMs ?? NaN),
  );
  row(
    "           t0 → last chunk read",
    l.map((y) => y.fetchEndMs ?? NaN),
  );
  row(
    "           t0 → code ready (all plugins)",
    l.map((y) => y.codeReadyMs ?? NaN),
  );
  row(
    "           main-thread script t0 → ready",
    l.map((y) => y.codeScriptMs ?? NaN),
  );
  row(
    "BASELINE   t0 → pane box",
    b.map((y) => y.boxMs),
  );
  row(
    "(code ran) t0 → content painted",
    b.map((y) => y.paintedMs),
  );
  row(
    "           script t0 → painted",
    b.map((y) => y.scriptMs),
  );
  row(
    "FIRST USE  t0 → pane box",
    x.map((y) => y.boxMs),
  );
  row(
    "(held)     t0 → code ready (all plugins)",
    x.map((y) => y.codeReadyMs ?? NaN),
  );
  row(
    "           t0 → content painted",
    x.map((y) => y.paintedMs),
  );
  row(
    "           script t0 → painted",
    x.map((y) => y.scriptMs),
  );
  const extra = (f: (y: Row) => number) =>
    x.flatMap((y, i) => {
      const base = b[i];
      return base === undefined ? [] : [f(y) - f(base)];
    });
  row(
    "EXTRA      painted (first use − baseline)",
    extra((y) => y.paintedMs),
  );
  row(
    "           script",
    extra((y) => y.scriptMs),
  );
}
if (out !== undefined)
  await Bun.write(
    out,
    JSON.stringify(
      results,
      (_k, v: unknown) => (v instanceof Set ? [...(v as Set<unknown>)] : v),
      2,
    ),
  );
