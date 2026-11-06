/**
 * What a perf number was measured ON — printed before any frame time, so a
 * figure from a software-rendered or demoted browser can never pass for one
 * from the user's Chrome.
 *
 * Two traps this exists for (research/2026-10-16-map-zoom-smoothness.md):
 *
 * - `withBrowser` runs chrome-headless-shell unless `--headed`, which
 *   rasterizes and composites in software (SwiftShader): paint, raster and
 *   compositing cost nothing like they do on a GPU.
 * - A darwinbg Chromium (E-cores, throttled) waits to be scheduled, and every
 *   frame time reports the wait as work — on a loaded host ~96 % of it
 *   (research/2026-11-06-apps-demo-main-thread-is-scheduling-starvation.md).
 *   `./equin run` spawns an e2e script in the foreground, so this should read
 *   `foreground`; the tier is READ (a self read, the only trustworthy one —
 *   packages/spawn-priority) rather than assumed, because a script run some
 *   other way, or a later change to how runs are admitted, would otherwise
 *   print starved numbers as real ones. The launched Chromium inherits this
 *   process's tier at spawn; an `--attach`ed run drives the agent browser
 *   session's Chromium instead, whose tier this process cannot read.
 */

import type { Page } from "playwright";
import { readDarwinBackground } from "@plugins/packages/plugins/spawn-priority/core";
import { arg, flag } from "./args";

export interface RenderEnv {
  headless: boolean;
  /** The WebGL renderer string, unmasked — "SwiftShader" means no GPU. */
  gpu: string;
  softwareGpu: boolean;
  devicePixelRatio: number;
  /** Median rAF interval at rest: the display's refresh as the page sees it. */
  frameMs: number;
  /**
   * The scheduling tier of the Chromium measured: this process's own (read
   * back), which the browser it launched inherited — or `unknown` for an
   * `--attach`ed run, whose browser this process did not launch.
   */
  tier: "darwinbg" | "foreground" | "unsupported" | "unknown";
}

export async function describeRenderEnv(page: Page): Promise<RenderEnv> {
  const inPage = await page.evaluate(async () => {
    const gl = document.createElement("canvas").getContext("webgl");
    let gpu = "none (no WebGL)";
    if (gl !== null) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      gpu = String(
        gl.getParameter(
          info === null ? gl.RENDERER : info.UNMASKED_RENDERER_WEBGL,
        ),
      );
    }
    const gaps: number[] = [];
    await new Promise<void>((done) => {
      let last = -1;
      const tick = (t: number) => {
        if (last >= 0) gaps.push(t - last);
        last = t;
        if (gaps.length < 60) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    gaps.sort((a, b) => a - b);
    return {
      gpu,
      devicePixelRatio: window.devicePixelRatio,
      frameMs: gaps[Math.floor(gaps.length / 2)] ?? 0,
    };
  });
  return {
    headless: !flag("headed"),
    ...inPage,
    softwareGpu: /swiftshader|llvmpipe|software/i.test(inPage.gpu),
    tier:
      arg("attach") !== undefined ? "unknown" : readDarwinBackground().kind,
  };
}

/** The env as report lines; the second warns when the numbers are not a real browser's. */
export function renderEnvLines(env: RenderEnv): string[] {
  const lines = [
    `[env] ${env.headless ? "headless shell" : "headed"}, gpu "${env.gpu}", dpr ${env.devicePixelRatio}, frame ${env.frameMs.toFixed(1)} ms, scheduling tier ${env.tier}`,
  ];
  const caveats = [
    ...(env.softwareGpu
      ? ["software GPU (paint/raster/composite unreal)"]
      : []),
    ...(env.tier === "darwinbg"
      ? ["darwinbg CPU (frame times are mostly scheduler waits)"]
      : []),
    ...(env.tier === "unknown"
      ? ["attached browser of unknown scheduling tier"]
      : []),
  ];
  if (caveats.length > 0) {
    lines.push(
      `[env] NOT a real browser's numbers: ${caveats.join("; ")} — compare runs against each other only`,
    );
  }
  return lines;
}
