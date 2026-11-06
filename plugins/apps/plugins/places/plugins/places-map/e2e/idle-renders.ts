// How often the Places screen re-renders while nothing happens, with a place
// card open — the render-loop reports' "noop-attr @ 45–162/s" on /places
// (every React commit re-assigns an <input>'s `name`). Profiles React commits
// (debug/render-profiler) in three idle phases on THIS checkout's deploy: the
// bare map, a card open with the pointer away, and the pointer resting on the
// selected pin. Run `--headed` for the vector map (a Map ID draws raster in
// the headless shell).
//
// Usage:
//   ./equin run plugins/apps/plugins/places/plugins/places-map/e2e/idle-renders.ts \
//     [--headed] [--seconds 6] [--zoom 4]
//
// Prints each phase's commits/s and its top initiators; exits non-zero when
// PlacesSurface re-renders more than once a second while idle.

import {
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  formatProfilerReport,
  RENDER_PROFILER_GLOBAL,
  type ProfilerReport,
  type RenderProfilerWindow,
} from "@plugins/debug/plugins/render-profiler/core";
import type { Page } from "playwright";

const PROFILER: typeof RENDER_PROFILER_GLOBAL = RENDER_PROFILER_GLOBAL;
const seconds = numArg("seconds", 6);
const zoomSteps = numArg("zoom", 4);

async function profile(
  page: Page,
  phase: string,
  during: () => Promise<void> = () => page.waitForTimeout(seconds * 1000),
): Promise<number> {
  await page.evaluate(
    ({ g, ms }: { g: typeof RENDER_PROFILER_GLOBAL; ms: number }) =>
      (window as RenderProfilerWindow)[g]?.start({ maxDurationMs: ms }),
    { g: PROFILER, ms: seconds * 1000 + 5000 },
  );
  await during();
  const report: ProfilerReport = await page.evaluate(
    (g: typeof RENDER_PROFILER_GLOBAL) => {
      const api = (window as RenderProfilerWindow)[g];
      if (!api) throw new Error(`window.${g} is not installed`);
      api.stop();
      return api.getReport();
    },
    PROFILER,
  );
  console.log(`\n=== ${phase}: ${report.totalCommits} commits in ${seconds}s`);
  console.log(formatProfilerReport(report, { top: 6 }));
  const surface = report.initiators.filter((i) =>
    i.signature.includes("PlacesSurface"),
  );
  const count = surface.reduce((n, i) => n + i.commitCount, 0);
  const fibers = surface.reduce((n, i) => n + i.fibersRendered, 0);
  console.log(
    `PlacesSurface: ${count} re-renders, ${fibers} fibers rendered under it`,
  );
  return count / seconds;
}

const ok = await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByPlaceholder("Search or add places")
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(5000);
  const rendering = await page
    .locator("text=Map ID isn't a vector map")
    .count();
  console.log(
    `map: ${rendering > 0 ? "raster (Map ID refused)" : "vector or no Map ID"}`,
  );

  const rates: Record<string, number> = {};
  rates.bare = await profile(page, "bare map");

  // Open the first place of the side panel: its pin is lifted into the DOM
  // (the active pin), and the map pans to it when the chrome covers it.
  const row = page.locator("button[data-row-key]").first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.waitForTimeout(3000);
  const pin = page.locator(".gm-style [role=button][aria-label]").first();
  const label = await pin.getAttribute("aria-label");
  const pinAt = async () => {
    const b = await pin.boundingBox();
    if (b === null) throw new Error(`selected pin ${label} is not laid out`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  // Zoom in with the pointer on the selected pin: it stays under it.
  let at = await pinAt();
  for (let i = 0; i < zoomSteps; i++) {
    at = await pinAt();
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(2000);
  at = await pinAt();
  console.log(
    `opened ${label}, its pin at ${Math.round(at.x)},${Math.round(at.y)}`,
  );

  await page.mouse.move(640, 860);
  await page.waitForTimeout(1500);
  rates.cardAway = await profile(page, "card open, pointer away");

  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(1500);
  rates.cardHover = await profile(
    page,
    "card open, pointer on the selected pin",
  );

  // The pointer gliding over the pins around it (no press, no key: the
  // render-loop detector counts this as idle) — the hovered pin changes as
  // it crosses them.
  const sweep = await profile(
    page,
    "pointer sweeping over the pins",
    async () => {
      const steps = seconds * 60;
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2 * 3;
        await page.mouse.move(
          at.x + Math.cos(t) * 220,
          at.y + Math.sin(t * 2) * 140,
        );
        await page.waitForTimeout(16);
      }
    },
  );

  console.log(
    `\nPlacesSurface re-renders/s: ${JSON.stringify({ ...rates, sweep })}`,
  );
  return Object.values(rates).every((r) => r <= 1);
});
if (!ok) process.exitCode = 1;
