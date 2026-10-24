/**
 * The piano roll in a browser with NO GPU: it must say so, not draw a roll with
 * note letters and no notes (what Pixi's 2D-canvas fallback used to produce).
 *
 * Chromium flags can't be passed through the harness, so the GPU is taken away
 * from inside the page before any script runs: `navigator.gpu` is removed (no
 * WebGPU) and `getContext("webgl"/"webgl2")` returns null (no WebGL) — exactly
 * what a browser with hardware acceleration switched off reports.
 *
 *   ./equin build
 *   ./equin run plugins/apps/plugins/sonata/plugins/piano-roll/e2e/gpu-unavailable.ts --out /tmp/no-gpu
 */
import { errors } from "playwright";
import {
  arg,
  numArg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? "/tmp/piano-roll-no-gpu";
/** Rachmaninoff — the same default song as look-verify. */
const song = arg("song") ?? "ea7bdc72-1ea0-41cb-a05e-96d506e2a948";
// A cold player parses the MIDI before the display mounts; see look-verify.
const settleMs = numArg("settle", 60_000);
const MESSAGE = "Can't draw notes: the browser has no GPU available.";

await withBrowser(async (h) => {
  const r = report("piano-roll-gpu-unavailable");
  const { page, captured } = await h.session();

  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", {
      get: () => undefined,
      configurable: true,
    });
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === "webgl" || type === "webgl2" || type === "webgpu") {
        return null;
      }
      return (original as (...a: unknown[]) => unknown).call(
        this,
        type,
        ...rest,
      );
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  await page.goto(pathUrl(`/sonata/song/${song}`), {
    waitUntil: "domcontentloaded",
  });

  let shown = true;
  try {
    await page.getByText(MESSAGE).waitFor({ timeout: settleMs });
  } catch (err) {
    if (!(err instanceof errors.TimeoutError)) throw err;
    shown = false;
  }
  r.ok(
    "GPU-unavailable message shown",
    shown,
    `no message after ${settleMs}ms`,
  );
  r.ok(
    "no Pixi canvas mounted",
    (await page.locator("canvas").count()) === 0,
    "a <canvas> is on the page — Pixi fell back to a renderer anyway",
  );
  await snap(page, out, "no-gpu");

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
