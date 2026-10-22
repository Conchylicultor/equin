import { join, normalize } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import { readBrowserExecutables } from "@plugins/infra/plugins/deps/plugins/playwright-browser/core";
import type { FixtureMutation } from "@plugins/primitives/plugins/css/plugins/layout-harness/plugins/geometry/core";
import type { HarnessWindow } from "./harness-window";
import type { MeasuredFixture } from "@plugins/primitives/plugins/css/plugins/layout-harness/core";

// One headless Chromium + one Page reused across the whole catalog (as the
// bespoke geometry tests already do in beforeAll/afterAll). `measure` re-renders
// a fixture at a width (optionally with a falsification mutation applied to the
// painted DOM) and reads back the MeasuredFixture — all in-page, no reload.
//
// The built page is served over a LOCAL HTTP server (not `file://`): Vite emits
// ES-module `<script type="module">` + a stylesheet `<link>`, and under `file://`
// the browser treats every asset as cross-origin (`origin: null`) and CORS-blocks
// the module/stylesheet fetch. http://127.0.0.1:<port> gives every asset the same
// real origin (the `file://`-fallback the harness design calls out).

export interface Measurer {
  measure(
    id: string,
    width: number,
    falsify?: FixtureMutation,
  ): Promise<MeasuredFixture>;
  /**
   * Uncaught page errors observed since the last call, and CLEARED by it.
   *
   * Drain-on-read is what makes attribution possible: the suite drains once
   * after the page loads and again after each fixture's sweep, so an error
   * belongs to the fixture that was on screen when it fired rather than to
   * every fixture measured after it.
   */
  takePageErrors(): string[];
  close(): Promise<void>;
}

const CONTENT_TYPE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (
    CONTENT_TYPE[dot >= 0 ? path.slice(dot) : ""] ?? "application/octet-stream"
  );
}

/**
 * Serve `outDir` statically on an ephemeral localhost port. Path-traversal is
 * blocked by normalizing and rejecting anything that escapes `outDir`.
 */
function serveDir(outDir: string): { origin: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const rel = decodeURIComponent(
        url.pathname === "/" ? "/entry.html" : url.pathname,
      );
      const abs = normalize(join(outDir, rel));
      if (!abs.startsWith(outDir))
        return new Response("forbidden", { status: 403 });
      const file = Bun.file(abs);
      if (!(await file.exists()))
        return new Response("not found", { status: 404 });
      return new Response(file, {
        headers: { "content-type": contentTypeFor(abs) },
      });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => {
      // Force-close in-flight connections; we don't await the returned promise
      // (the browser is already closed by the time we stop the server).
      void server.stop(true);
    },
  };
}

/**
 * The installed headless Chromium, installing it first if needed.
 *
 * Chromium is an on-demand dependency (`chromium`, declared by
 * safe-fetch/browser-fetch). This file sits under `web/`, whose row cannot
 * reach the `deps/` engine barrel, so it asks the engine's process boundary
 * instead — `./singularity deps install chromium --json`, a no-op printing
 * where the install lives once it is there (the `layout-geometry` check has
 * already installed it before this suite runs) — and reads the executables
 * the install recorded, as Playwright reported them, through the kind's
 * `core` reader. So the suite runs the same way under the check and under a
 * plain `./singularity test`.
 */
async function installedHeadlessChromium(): Promise<string> {
  const root = await getWorktreeRoot();
  const argv = [`${root}/singularity`, "deps", "install", "chromium", "--json"];
  const res = await spawnCaptured(argv, { cwd: root, timeoutMs: 30 * 60_000 });
  if (res.exitCode !== 0 || res.timedOut) {
    throw new Error(
      `${argv.slice(1).join(" ")} ${res.timedOut ? "timed out" : `exited ${res.exitCode}`}:\n${res.stderr.trim().split("\n").slice(-20).join("\n")}`,
    );
  }
  const { dir } = z
    .object({ dir: z.string() })
    .parse(JSON.parse(res.stdout.trim().split("\n").at(-1) ?? ""));
  const read = readBrowserExecutables(dir);
  if (!read.ok) throw new Error(`chromium at ${dir}: ${read.reason}`);
  return read.executables.headlessShell;
}

export async function openMeasurer(outDir: string): Promise<Measurer> {
  const executablePath = await installedHeadlessChromium();
  const srv = serveDir(outDir);
  // Playwright's default launch timeout is 30s. Under host load (a CI box or a
  // box running several worktree servers) cold Chromium startup can briefly
  // exceed that even when serialized — a slow launch is not a real failure, so
  // give it generous headroom rather than flaking the geometry gate.
  const browser: Browser = await chromium.launch({
    executablePath,
    timeout: 120_000,
  });
  const page: Page = await browser.newPage();

  // A fixture that CRASHES must fail the gate, and until this listener existed
  // it could not: `__measure` reads whatever `[data-geo]` boxes are still in the
  // DOM, and React tearing a subtree down leaves that DOM behind for at least
  // one frame — so the settle loop happily agreed with itself twice and the
  // suite measured a corpse. The Layout Lab died of exactly this for months
  // (an adaptive-bar guard looping into React #185) with the gate green.
  //
  // We listen for `pageerror` ONLY — "an exception reached the top of the page"
  // — and deliberately not for `console` messages of type `error`. Those are a
  // much wider class: a 404 on a source map, a font that failed to load, a
  // component's own diagnostic `console.error`. None of them means a fixture
  // stopped rendering, and failing the geometry gate on them would make it fire
  // for reasons that have nothing to do with geometry. Nothing in the class we
  // DO care about is console-only: the measurer page mounts no error boundary,
  // so React funnels every uncaught render/commit error through `reportError`,
  // which surfaces here. (An unhandled promise rejection during the async
  // fixture load is caught earlier and differently — `__fixturesReady` never
  // flips, so `waitForFunction` below times out.)
  const pageErrors: string[] = [];
  page.on("pageerror", (err: Error) => {
    pageErrors.push(err.stack ?? `${err.name}: ${err.message}`);
  });

  await page.goto(`${srv.origin}/entry.html`);
  // The entry sets `window.__fixturesReady` after loadExhibits() resolves and the
  // globals are installed; wait for it rather than the bare function existence so
  // we never race the async fixture load.
  await page.waitForFunction(
    () => (window as HarnessWindow).__fixturesReady === true,
    undefined,
    {
      timeout: 30_000,
    },
  );

  return {
    async measure(id, width, falsify) {
      return page.evaluate(
        ({ id, width, falsify }) => {
          (window as HarnessWindow).__renderFixture(id, width, falsify);
          return new Promise<MeasuredFixture>((resolve) => {
            // Settle by OBSERVATION, not by a frame count.
            //
            // The double-rAF this replaces assumed layout is final once the
            // render has been committed and painted, which holds only while
            // layout is pure synchronous CSS. A primitive that lays itself out
            // from a `ResizeObserver` — the adaptive bar, and every future
            // measure-then-decide primitive — settles LATER by construction:
            // the observer callback is delivered after layout, its handler is
            // rAF-debounced, and each decision it commits is a React render
            // whose own layout effect may measure and decide again. That is
            // several frames, and the number is a property of the fixture, not
            // a constant the harness can know.
            //
            // Measuring mid-settle reads a transient, so the gate would assert
            // on the PREVIOUS width's layout and fail with real-looking overlaps
            // — which is exactly what it did. Re-measure until two consecutive
            // frames agree, with a cap so a genuinely oscillating layout fails
            // loudly on its own geometry rather than hanging the suite.
            const MAX_SETTLE_FRAMES = 30;
            let previous: string | null = null;
            let frames = 0;
            const settle = (): void => {
              const measured = (window as HarnessWindow).__measure();
              const signature = JSON.stringify(measured);
              if (signature === previous || frames >= MAX_SETTLE_FRAMES) {
                resolve(measured);
                return;
              }
              previous = signature;
              frames += 1;
              requestAnimationFrame(settle);
            };
            requestAnimationFrame(() => requestAnimationFrame(settle));
          });
        },
        { id, width, falsify },
      );
    },
    takePageErrors() {
      return pageErrors.splice(0, pageErrors.length);
    },
    async close() {
      await browser.close();
      srv.stop();
    },
  };
}
