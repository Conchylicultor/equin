// The desktop ↔ full screen switch's work budget: how many elements each
// switch restyles (Chrome's trace, `UpdateLayoutTree`), against a budget per
// case — entering and leaving full screen, with one window and with four.
//
// The count is the work, not its time: it is stable run to run (±0.5 % on the
// switch's big recalcs; the whole switch's warm median within ~15 %), where CPU
// time varies 2–3× with the host's load. Each regression the switch has had
// was a jump of the order of the document's element count — a custom property
// written on <html>, the root theme following the focused app, a
// `:not(.class *)` selector toggled on a tab, hidden tabs back to
// `display: none`, icon sprites rendered — so the budgets sit at ~2× today's
// numbers and far under one whole-document restyle.
//
// Deterministic content: the `/demo` page, entered maximized at the desktop
// with Sonata — the real app's code on the demo's seeded data (in a worker, no
// writes to the host), never the user's live library — so every run measures
// the same document.
//
// Each case: `--rounds` switches each way; round 1 styles the full-screen and
// desktop subtrees for the first time (cold) and is left out; the verdict is
// the median of the warm rounds.
//
// Usage:
//   ./equin run plugins/apps/plugins/desktop/plugins/fullscreen-budget/e2e/fullscreen-switch-budget.ts \
//     [--rounds 4] [--settle 1500] [--url http://<namespace>.localhost:9000]
//
// On demand it prints the verdict and exits 1 while a case is over budget.
// Main's `desktop.fullscreen-budget` job (after each of main's builds) adds
// `--file-reports --commit <sha>`: an over-budget run files one
// `interaction-budget` report naming the commit range and exits 0 once it is
// filed; a within-budget run records the commit as the range's next start.
//
// To find the cause of a jump, profile the switch:
// `plugins/apps/plugins/desktop/plugins/windows/e2e/fullscreen-switch-profile.ts`.

import type { Locator, Page } from "playwright";
import {
  arg,
  flag,
  numArg,
  pathUrl,
  usage,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openFloatingActionBar } from "@plugins/shell/plugins/global-action-bar/e2e";
import {
  bootDemo,
  demoPath,
  embedRoot,
  RENDER_TIMEOUT_MS,
} from "@plugins/apps/plugins/demo/e2e";
import {
  shownWindowIds,
  traceSwitch,
} from "@plugins/apps/plugins/desktop/plugins/windows/e2e";
import { settleBudget } from "@plugins/reports/plugins/interaction-budget/e2e";
import type { BudgetCase } from "@plugins/reports/plugins/interaction-budget/core";

const SCRIPT =
  "plugins/apps/plugins/desktop/plugins/fullscreen-budget/e2e/fullscreen-switch-budget.ts";

const rounds = numArg("rounds", 4);
const settle = numArg("settle", 1500);
const fileReports = flag("file-reports");
const commit = arg("commit");
if (fileReports && (commit === undefined || commit === ""))
  usage("--file-reports needs --commit <the deployed commit it measures>");
if (rounds < 2) usage("--rounds must be at least 2 (round 1 is cold)");

/** The app the desktop's windows show — its demo library is seeded, fixed. */
const APP = "sonata";

/**
 * Elements restyled per switch, warm median. Today (2026-11-11, main
 * 2e0354ce5f): 1 window enter ~0.8–1k, exit ~2.2k; 4 windows enter ~1.3–1.5k,
 * exit ~3.5–4k; one whole-document restyle of this page is ~18–20k.
 */
const BUDGETS = [
  { windows: 1, direction: "enter", budget: 3000 },
  { windows: 1, direction: "exit", budget: 5000 },
  { windows: 4, direction: "enter", budget: 4000 },
  { windows: 4, direction: "exit", budget: 8000 },
] as const;

type Direction = (typeof BUDGETS)[number]["direction"];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function expectWindows(root: Locator, n: number): Promise<void> {
  const settled = await waitFor(
    () => shownWindowIds(root),
    (ids) => ids.length === n,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  if (!settled.ok)
    throw new Error(
      `expected ${n} shown desktop windows, got ${settled.value.length}`,
    );
}

/**
 * `rounds` round trips (full screen from the last window's titlebar, back
 * through the action bar's Layout control); each direction's elements
 * restyled per round. The Layout popover opens before the exit is traced, so
 * only the radio's click is billed to it.
 */
async function roundTrips(
  page: Page,
  root: Locator,
): Promise<Record<Direction, number[]>> {
  const out: Record<Direction, number[]> = { enter: [], exit: [] };
  const fullscreen = root.getByRole("button", { name: "Full screen" }).last();
  const gear = page.locator('[data-ui-owner^="ViewOptionsButton@"]');
  for (let round = 1; round <= rounds; round++) {
    const enter = await traceSwitch(page, root, () => fullscreen.click(), {
      settleMs: settle,
    });
    out.enter.push(enter.styled);
    await expectWindows(root, 0);
    await page.waitForTimeout(1000);
    if (await gear.evaluate((el) => el.closest("[inert]") !== null))
      await openFloatingActionBar(page);
    await gear.click();
    const desktop = page.getByRole("radio", { name: "Desktop", exact: true });
    await desktop.waitFor();
    await page.waitForTimeout(500);
    const exit = await traceSwitch(page, root, () => desktop.click(), {
      settleMs: settle,
    });
    out.exit.push(exit.styled);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
    console.log(
      `  round ${round}${round === 1 ? " (cold)" : ""}: enter ${enter.styled}, exit ${exit.styled}`,
    );
  }
  return out;
}

const cases: BudgetCase[] = [];

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  await bootDemo(page, pathUrl(demoPath(`/desktop/${APP}`, { full: true })), {
    marker: "[data-floating-window-id]",
  });
  const root = embedRoot(page);
  await expectWindows(root, 1);
  await page.waitForTimeout(3000);

  let open = 1;
  for (const windows of [...new Set(BUDGETS.map((b) => b.windows))]) {
    // More windows of the same app: Alt+N, the desktop's new window, on the
    // focused one.
    for (; open < windows; open++) {
      await root.locator("[data-floating-window-id]").first().click();
      await page.keyboard.press("Alt+n");
      await expectWindows(root, open + 1);
      await page.waitForTimeout(2000);
    }
    const elements = await page.evaluate(
      () => document.getElementsByTagName("*").length,
    );
    console.log(`\n${windows} window(s), ${elements} elements in the page:`);
    const measured = await roundTrips(page, root);
    for (const b of BUDGETS.filter((x) => x.windows === windows)) {
      const warm = measured[b.direction].slice(1);
      cases.push({
        id: `${b.direction}-${windows}w`,
        label: `${b.direction === "enter" ? "enter full screen" : "exit full screen"}, ${windows} window${windows === 1 ? "" : "s"}`,
        measured: median(warm),
        budget: b.budget,
        samples: warm,
      });
    }
  }
});

const verdict = await settleBudget({
  scenario: "desktop.fullscreen-switch",
  title: "Desktop ↔ full screen switch",
  metric: "elements restyled",
  cases,
  rerun: `./equin run ${SCRIPT}`,
  hint:
    "**Finding the cause:** profile the switch with " +
    "`./equin run plugins/apps/plugins/desktop/plugins/windows/e2e/fullscreen-switch-profile.ts " +
    "--windows 3 --invalidations` — it lists each whole-document recalc, the <html> " +
    "attribute writes and the <style> elements the switch touched, and what scheduled " +
    "the invalidations. Past causes, each a jump of about the document's element count: " +
    "a custom property written on <html>, the root theme following the focused app, a " +
    "`:not(.class *)` selector toggled on a tab, hidden tabs back to `display: none` " +
    "(per window), icon sprites rendered.",
  file: fileReports && commit !== undefined ? { commit } : null,
});
// A filed report is the verdict delivered; on demand the exit code is.
if (verdict.kind === "over" && !verdict.filed) process.exit(1);
