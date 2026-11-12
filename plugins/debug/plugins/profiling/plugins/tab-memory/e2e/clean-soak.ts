// Clean soak: a tab's native memory over time with NOTHING attached to the
// page. Playwright enables the Network and Runtime domains on every page it
// drives (the inspector then keeps response bodies and console arguments) and
// a heap snapshot leaves malloc high-water behind — both inflate exactly the
// native memory this measures. So this spawns chrome-headless-shell itself,
// opens each URL in its own browser, and talks CDP only to the BROWSER target:
// a memory-infra dump every `--every` seconds, per renderer process.
//
//   ./equin run plugins/debug/plugins/profiling/plugins/tab-memory/e2e/clean-soak.ts \
//     --urls http://equin.localhost:9000/agents,http://equin.localhost:9000/agents/c/<id> \
//     [--minutes 30] [--every 120] [--out "$EQUIN_SCRATCH/clean"]
//
// With `--paths p1,p2,…` it drives the in-app session instead: `--rounds` times,
// visit each path in turn (history.pushState + popstate, `--dwell` ms each)
// through `Runtime.evaluate` on a flat page session — no domain enabled, so
// nothing is buffered — and dump after every round.
//
// With `--tabs` as well, each path opens in its OWN in-app tab instead (the
// surface switched to docked so the tab bar shows; New tab, then the in-app
// navigation), with a dump after each tab opens; then `--rounds` times, focus
// every tab in turn (its tab-bar chip) and dump after the round. That is what
// a day of opened tabs costs a browser tab — how many apps stay mounted.
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arg,
  flag,
  numArg,
  requireArg,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { readBrowserExecutablesSync } from "@plugins/infra/plugins/deps/plugins/playwright-browser/core";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";

const urls = requireArg("urls", "--urls <url,url…>").split(",");
const minutes = numArg("minutes", 30);
const every = numArg("every", 120);
const out = requireArg(
  "out",
  "--out <path prefix>, e.g. a file under your scratch dir",
);
/** How long one memory dump may take before the browser is taken as gone. */
const DUMP_DEADLINE_MS = 60_000;

/** The headless shell the e2e harness launches, installed on demand like it. */
async function headlessShell(): Promise<string> {
  const explicit = arg("chromium");
  if (explicit) return explicit;
  const installed = await ensureDepViaCli(chromium, {
    stdio: "inherit",
    grant: null,
  });
  const recorded = readBrowserExecutablesSync(installed.dir);
  if (!recorded.ok)
    throw new Error(`chromium install unreadable: ${recorded.reason}`);
  return recorded.executables.headlessShell;
}

class Cdp {
  private id = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<string, ((p: unknown) => void)[]>();
  constructor(private ws: WebSocket) {
    // A browser that crashed or went away fails every call in flight, loudly.
    ws.addEventListener("close", () => {
      for (const p of this.pending.values())
        p.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: unknown;
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners.get(msg.method) ?? []) l(msg.params);
      }
    });
  }
  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    this.ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      }),
    );
  }
  on(method: string, fn: (p: unknown) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
    return () =>
      this.listeners.set(
        method,
        list.filter((f) => f !== fn),
      );
  }
}

interface Row {
  url: string;
  t: number;
  pid: number;
  footprintMB: number;
  allocators: Record<string, number>;
}

const mb = (hex: string | undefined): number =>
  hex ? parseInt(hex, 16) / 1048576 : 0;

async function dump(
  cdp: Cdp,
): Promise<
  { pid: number; footprintMB: number; allocators: Record<string, number> }[]
> {
  const info = await cdp.send<{ processInfo: { type: string; id: number }[] }>(
    "SystemInfo.getProcessInfo",
  );
  const renderers = new Set(
    info.processInfo.filter((p) => p.type === "renderer").map((p) => p.id),
  );
  const events: {
    ph: string;
    pid: number;
    args?: {
      dumps?: {
        allocators?: Record<
          string,
          { attrs?: Record<string, { value: string }> }
        >;
        process_totals?: Record<string, string>;
      };
    };
  }[] = [];
  const off = cdp.on("Tracing.dataCollected", (p) =>
    events.push(...(p as { value: typeof events }).value),
  );
  let offComplete = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve, reject) => {
    offComplete = cdp.on("Tracing.tracingComplete", () => resolve());
    // A bound around the browser peer, not a fix for our own code: a dump
    // that never completes means the browser is gone or wedged.
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `memory dump did not complete within ${DUMP_DEADLINE_MS} ms`,
          ),
        ),
      DUMP_DEADLINE_MS,
    );
  });
  try {
    await cdp.send("Tracing.start", {
      traceConfig: {
        includedCategories: ["disabled-by-default-memory-infra"],
        excludedCategories: ["*"],
        memoryDumpConfig: { triggers: [] },
      },
      transferMode: "ReportEvents",
    });
    await cdp.send("Tracing.requestMemoryDump", {
      deterministic: true,
      levelOfDetail: "detailed",
    });
    await cdp.send("Tracing.end");
    await done;
  } finally {
    clearTimeout(timer);
    offComplete();
    off();
  }
  const by = new Map<
    number,
    { pid: number; footprintMB: number; allocators: Record<string, number> }
  >();
  for (const e of events) {
    if (e.ph !== "v" || !renderers.has(e.pid) || !e.args?.dumps) continue;
    const r = by.get(e.pid) ?? { pid: e.pid, footprintMB: 0, allocators: {} };
    const pt = e.args.dumps.process_totals;
    if (pt?.private_footprint_bytes)
      r.footprintMB = mb(pt.private_footprint_bytes);
    for (const [name, a] of Object.entries(e.args.dumps.allocators ?? {})) {
      const v = a.attrs?.["effective_size"]?.value ?? a.attrs?.["size"]?.value;
      if (v === undefined) continue;
      if (
        !name.includes("/") ||
        /^(v8\/main\/heap|partition_alloc\/partitions)\/[a-z_]+$/.test(name)
      )
        r.allocators[name] = mb(v);
    }
    by.set(e.pid, r);
  }
  return [...by.values()];
}

const paths = (arg("paths", "") ?? "").split(",").filter(Boolean);
const rounds = numArg("rounds", 6);
const dwell = numArg("dwell", 3000);
const asTabs = flag("tabs");

async function evaluate(
  cdp: Cdp,
  session: string,
  expression: string,
): Promise<unknown> {
  const r = await cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  if (r.exceptionDetails)
    throw new Error(`evaluate: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value;
}

/**
 * Put the tab set in docked mode (the tab bar shows) by editing its persisted
 * entry and reloading — a reload adopts the same app instance, mode included.
 */
const DOCK_AND_RELOAD = `(() => {
  const key = Object.keys(sessionStorage).find((k) => k.startsWith("s:apps-core.tabs:"));
  if (!key) throw new Error("no persisted tab set in sessionStorage");
  const entry = JSON.parse(sessionStorage.getItem(key));
  entry.v.mode = "docked";
  sessionStorage.setItem(key, JSON.stringify(entry));
  setTimeout(() => location.reload(), 0);
  return key;
})()`;

/** Open a new in-app tab and route it to `path` (the focused tab follows the URL). */
const openTabAt = (path: string): string => `(async () => {
  const button = document.querySelector('button[aria-label="New tab"]');
  if (!button) throw new Error("no New tab button (is the surface docked?)");
  button.click();
  await new Promise((r) => setTimeout(r, 1000));
  history.pushState(null, "", ${JSON.stringify(path)});
  dispatchEvent(new PopStateEvent("popstate", { state: null }));
  return document.querySelectorAll("[data-app-tab]").length;
})()`;

/** Focus the `i`-th tab through its tab-bar chip. */
const focusTabAt = (i: number): string => `(() => {
  const chip = document.querySelectorAll("[data-app-tab]")[${i}];
  const target = chip?.querySelector('[role="button"][aria-pressed]');
  if (!target) throw new Error("no tab chip ${i}");
  target.click();
  return location.pathname;
})()`;

async function pageSession(cdp: Cdp): Promise<string> {
  const { targetInfos } = await cdp.send<{
    targetInfos: { targetId: string; type: string }[];
  }>("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const { sessionId } = await cdp.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId: page.targetId, flatten: true },
  );
  return sessionId;
}

async function navigate(
  cdp: Cdp,
  session: string,
  path: string,
): Promise<void> {
  const r = await cdp.send<{ exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    {
      expression: `history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate", { state: null })); 1`,
    },
    session,
  );
  if (r.exceptionDetails)
    throw new Error(`navigate ${path}: ${JSON.stringify(r.exceptionDetails)}`);
}

const exe = await headlessShell();
const rows: Row[] = [];

// Every spawned browser and its profile dir, recorded BEFORE anything can
// fail, so a failed launch, a throw mid-soak or Ctrl-C still cleans up all.
const spawned: { child: ChildProcess; dir: string; ws?: WebSocket }[] = [];
async function cleanup(): Promise<void> {
  await Promise.all(
    spawned.map(async (s) => {
      s.ws?.close();
      if (s.child.exitCode === null && s.child.signalCode === null) {
        const exited = new Promise((r) => s.child.once("exit", r));
        s.child.kill();
        await exited;
      }
      rmSync(s.dir, { recursive: true, force: true });
    }),
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().then(() => process.exit(130));
  });
}

async function launch(url: string): Promise<{ url: string; cdp: Cdp }> {
  const dir = mkdtempSync(join(tmpdir(), "clean-soak-"));
  const child = spawn(
    exe,
    [
      `--user-data-dir=${dir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--window-size=1400,900",
      url,
    ],
    { stdio: "ignore" },
  );
  const entry: (typeof spawned)[number] = { child, dir };
  spawned.push(entry);
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 300 && !existsSync(portFile); i++) {
    if (child.exitCode !== null)
      throw new Error(
        `chrome-headless-shell exited (${child.exitCode}) before listening`,
      );
    await Bun.sleep(100);
  }
  if (!existsSync(portFile))
    throw new Error(
      `chrome-headless-shell wrote no DevToolsActivePort within 30 s (${dir})`,
    );
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  entry.ws = ws;
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () =>
      reject(new Error(`CDP socket to ${url} failed to open`)),
    );
  });
  return { url, cdp: new Cdp(ws) };
}

let browsers: { url: string; cdp: Cdp }[] = [];

const report = async (t0: number, label?: string): Promise<void> => {
  for (const b of browsers) {
    for (const r of await dump(b.cdp)) {
      rows.push({
        url: label ?? b.url,
        t: Math.round((Date.now() - t0) / 1000),
        ...r,
      });
      const a = r.allocators;
      const f = (k: string): string => (a[k] ?? 0).toFixed(0);
      console.log(
        `${(label ?? `+${Math.round((Date.now() - t0) / 60000)}min`).padEnd(10)} ${b.url.replace(/^https?:\/\/[^/]+/, "").padEnd(30)} pid ${r.pid} footprint ${r.footprintMB.toFixed(0).padStart(5)}MB  malloc ${f("malloc")} v8 ${f("v8")} (old ${f("v8/main/heap/old_space")}) pa ${f("partition_alloc")} (buffer ${f("partition_alloc/partitions/buffer")}, array_buffer ${f("partition_alloc/partitions/array_buffer")}) blink_gc ${f("blink_gc")} web_cache ${f("web_cache")}`,
      );
    }
  }
  writeFileSync(`${out}.json`, JSON.stringify(rows, null, 1));
};

try {
  browsers = await Promise.all(urls.map(launch));
  const t0 = Date.now();
  await Bun.sleep(20_000); // boot settles
  if (paths.length > 0 && asTabs) {
    let sessions = await Promise.all(browsers.map((b) => pageSession(b.cdp)));
    await report(t0, "boot");
    await Promise.all(
      browsers.map((b, i) => evaluate(b.cdp, sessions[i]!, DOCK_AND_RELOAD)),
    );
    await Bun.sleep(20_000); // the reload settles
    // A reload is a new document: the page target keeps its id, but attach
    // again so the session is certainly the live one.
    sessions = await Promise.all(browsers.map((b) => pageSession(b.cdp)));
    for (const [k, p] of paths.entries()) {
      await Promise.all(
        browsers.map((b, i) => evaluate(b.cdp, sessions[i]!, openTabAt(p))),
      );
      await Bun.sleep(dwell);
      await report(t0, `+tab ${k + 1}`);
    }
    for (let r = 0; r < rounds; r++) {
      for (let k = 0; k <= paths.length; k++) {
        await Promise.all(
          browsers.map((b, i) => evaluate(b.cdp, sessions[i]!, focusTabAt(k))),
        );
        await Bun.sleep(dwell);
      }
      await report(t0, `round ${r}`);
    }
  } else if (paths.length > 0) {
    const sessions = await Promise.all(browsers.map((b) => pageSession(b.cdp)));
    await report(t0, "boot");
    for (let r = 0; r < rounds; r++) {
      for (const p of paths) {
        await Promise.all(
          browsers.map((b, i) => navigate(b.cdp, sessions[i]!, p)),
        );
        await Bun.sleep(dwell);
      }
      await report(t0, `round ${r}`);
    }
  }
  while (paths.length === 0) {
    await report(t0);
    if (Date.now() - t0 > minutes * 60_000) break;
    await Bun.sleep(every * 1000);
  }
} finally {
  await cleanup();
}
