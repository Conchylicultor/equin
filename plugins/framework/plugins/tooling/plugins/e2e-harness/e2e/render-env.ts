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
 * - An agent session is launched under `taskpolicy -b` (darwinbg), and the
 *   Chromium it spawns inherits it: E-cores, throttled I/O. Every frame time
 *   is inflated. The tier can only be read by the process itself (see
 *   packages/spawn-priority), so it is INFERRED here from the agent session
 *   that launched the run, and said to be inferred.
 */

import type { Page } from "playwright";
import { flag } from "./args";

export interface RenderEnv {
  headless: boolean;
  /** The WebGL renderer string, unmasked — "SwiftShader" means no GPU. */
  gpu: string;
  softwareGpu: boolean;
  devicePixelRatio: number;
  /** Median rAF interval at rest: the display's refresh as the page sees it. */
  frameMs: number;
  /** Launched from a Claude Code session, which agents run in darwinbg. */
  agentSession: boolean;
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
    agentSession: process.env.CLAUDECODE === "1",
  };
}

/** The env as report lines; the second warns when the numbers are not a real browser's. */
export function renderEnvLines(env: RenderEnv): string[] {
  const lines = [
    `[env] ${env.headless ? "headless shell" : "headed"}, gpu "${env.gpu}", dpr ${env.devicePixelRatio}, frame ${env.frameMs.toFixed(1)} ms${env.agentSession ? ", agent session (darwinbg inherited)" : ""}`,
  ];
  const caveats = [
    ...(env.softwareGpu
      ? ["software GPU (paint/raster/composite unreal)"]
      : []),
    ...(env.agentSession ? ["demoted CPU (frame times inflated)"] : []),
  ];
  if (caveats.length > 0) {
    lines.push(
      `[env] NOT a real browser's numbers: ${caveats.join("; ")} — compare runs against each other only`,
    );
  }
  return lines;
}
