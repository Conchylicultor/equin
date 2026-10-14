// Fold-motion probe: clicks a collapsible header twice (fold, then unfold) and
// samples the content's rendered height on every animation frame, so a fold
// that jumps (no tween), stalls (a long frame swallows it) or lands short (the
// tween measured an empty body) shows up as numbers rather than a feeling.
//
// Usage:
//   ./singularity run plugins/primitives/plugins/collapsible/e2e/fold-motion.ts \
//     --path /agents --header "Queue" [--settle 1500] [--headed]
//
// --header is the trigger's accessible name prefix (a group header's label).
// Prints, per click, the per-frame [ms, height] trace of the content the
// trigger controls (`aria-controls`), the longest frame gap, and how many
// distinct intermediate heights painted. Exit 1 when either direction painted
// no intermediate frame.

import {
  arg,
  numArg,
  requireArg,
  requirePage,
  withBrowser,
  report,
  waitFor,
  ELEMENT_TIMEOUT_MS,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE = "--path /agents --header Queue";
const url = requirePage(USAGE);
const header = requireArg("header", USAGE);
const settle = numArg("settle", 1500);
const out = arg("out");

interface Trace {
  frames: [number, number][];
  longestGapMs: number;
  intermediate: number;
}

const r = report(`fold motion: ${header}`);

await withBrowser(async (h) => {
  const { page } = await h.session({});
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const trigger = page
    .getByRole("button", { name: new RegExp(`^${header}`) })
    .first();
  await trigger.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
  // Let live reads land before measuring.
  await page.waitForTimeout(settle);
  const controls = await trigger.getAttribute("aria-controls");
  if (controls === null) throw new Error(`"${header}" has no aria-controls`);

  async function clickAndTrace(): Promise<Trace> {
    await page.evaluate((id) => {
      const w = window as unknown as { __trace: [number, number][] };
      w.__trace = [];
      const t0 = performance.now();
      const tick = () => {
        const el = document.getElementById(id);
        w.__trace.push([
          Math.round(performance.now() - t0),
          el ? Math.round(el.getBoundingClientRect().height) : -1,
        ]);
        if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, controls!);
    await trigger.click();
    await page.waitForTimeout(4200);
    const frames = await page.evaluate(
      () => (window as unknown as { __trace: [number, number][] }).__trace,
    );
    let longestGapMs = 0;
    for (let i = 1; i < frames.length; i++)
      longestGapMs = Math.max(longestGapMs, frames[i]![0] - frames[i - 1]![0]);
    // The endpoints are "absent or 0" and the full height; anything strictly
    // between them is a frame of the tween.
    const full = Math.max(...frames.map((f) => f[1]));
    const intermediate = new Set(
      frames.map((f) => f[1]).filter((v) => v > 0 && v < full),
    ).size;
    return { frames, longestGapMs, intermediate };
  }

  const fold = await clickAndTrace();
  await waitFor(
    async () => page.locator(`[id="${controls}"]`).count(),
    (n) => n === 0,
    { timeoutMs: 3000, intervalMs: 100 },
  );
  const unfold = await clickAndTrace();

  for (const [name, t] of [
    ["fold", fold],
    ["unfold", unfold],
  ] as const) {
    console.log(
      `${name}: longest frame gap ${t.longestGapMs}ms, ${t.intermediate} intermediate heights`,
    );
    console.log(
      "  " +
        t.frames
          // Each height once, at the frame it first painted.
          .filter((f, i, a) => i === 0 || f[1] !== a[i - 1]![1])
          .map(([ms, px]) => `${ms}:${px}`)
          .join(" "),
    );
  }
  if (out) await page.screenshot({ path: `${out}.png` });
  r.ok("fold paints intermediate frames", fold.intermediate > 0);
  r.ok("unfold paints intermediate frames", unfold.intermediate > 0);
});
await r.finish();
