// Profiles dragging the floating action bar off its home slot and back on THIS
// checkout's deploy (solo, the boot mode): the reservation is withdrawn as the
// bar leaves the slot and republished as it comes back, so the drag is where a
// costly safe-area write shows. Reports, per leg (off / back), Chrome's style
// and script totals (CPU), the elements restyled per recalc (exact, unlike CPU
// time on a busy host) and how many recalcs were whole-document.
//
// Usage:
//   ./equin run plugins/shell/plugins/global-action-bar/e2e/drag-profile.ts \
//     [--path /sonata] [--rounds 3] [--steps 30]

import {
  numArg,
  arg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const path = arg("path", "/sonata");
const rounds = numArg("rounds", 3);
const steps = numArg("steps", 30);

/** A recalc restyling at least this many elements is a whole-document one. */
const BIG_RECALC = 5000;

interface TraceEvent {
  name: string;
  ph: string;
  args?: { elementCount?: number; data?: { elementCount?: number } };
}

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  await page.goto(pathUrl(path));
  // The bar's own band — the one holding the health dot.
  const dot = page.locator(".floating-bar-band [data-health]").first();
  await dot.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  console.log(
    `elements: ${await page.evaluate(() => document.getElementsByTagName("*").length)}`,
  );
  const box = await dot.boundingBox();
  if (box === null) throw new Error("health dot has no box");
  const home = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const away = { x: 700, y: 450 };

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => {
    const { metrics: list } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
  };
  const browser = page.context().browser();
  if (browser === null) throw new Error("no browser to trace");

  const leg = async (
    label: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    await browser.startTracing(page, { categories: ["devtools.timeline"] });
    const before = await metrics();
    await page.mouse.move(to.x, to.y, { steps });
    await page.waitForTimeout(600); // the padding transition and its restyles
    const after = await metrics();
    const trace = await browser.stopTracing();
    const { traceEvents } = JSON.parse(trace.toString("utf8")) as {
      traceEvents: TraceEvent[];
    };
    const recalcs = traceEvents
      .filter(
        (e) => e.name === "UpdateLayoutTree" && (e.ph === "X" || e.ph === "E"),
      )
      .map((e) => e.args?.elementCount ?? e.args?.data?.elementCount ?? 0)
      .filter((n) => n > 0);
    const big = recalcs.filter((n) => n >= BIG_RECALC);
    const ms = (k: string) =>
      `${(((after[k] ?? 0) - (before[k] ?? 0)) * 1000).toFixed(0)}ms`;
    console.log(
      `  ${label} (${Math.round(from.x)},${Math.round(from.y)} → ${to.x},${to.y}): ` +
        `RecalcStyle ${ms("RecalcStyleDuration")} · Script ${ms("ScriptDuration")} · ` +
        `styled ${recalcs.reduce((n, r) => n + r, 0)} in ${recalcs.length} recalcs · ` +
        `${big.length} whole-document (${big.join(", ")})`,
    );
  };

  for (let round = 1; round <= rounds; round++) {
    console.log(`round ${round}`);
    await page.mouse.move(home.x, home.y);
    await page.mouse.down();
    await leg("off", home, away);
    await leg("back", away, { x: Math.round(home.x), y: Math.round(home.y) });
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
});
