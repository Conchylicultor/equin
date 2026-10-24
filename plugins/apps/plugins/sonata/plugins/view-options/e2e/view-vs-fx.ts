/**
 * THE ACCEPTANCE TEST for the control-panel vocabulary: the View popover and the
 * FX popover, in the same HUD, must agree.
 *
 * They are the falsifying pair. FX has always been real vocabulary
 * (`ControlPanel.Row select="switch"`); View used to be `FieldRenderer`s dropped
 * loose into a `Section`, which drew its own checkbox, its own radios and its own
 * padding. So a difference between the two panels is a difference between the
 * vocabulary and whatever a renderer felt like drawing — which is the whole
 * defect this exercise removes.
 *
 * What it measures, per panel: the panel's own width (the `menu` role, so both
 * must be the same number), the left edge of every row's label (one rail), the
 * height of every row (one row height), and which selection languages are drawn
 * (one language per meaning — no native checkbox and no native radio anywhere).
 *
 *   ./equin build
 *   bun plugins/apps/plugins/sonata/plugins/view-options/e2e/view-vs-fx.ts --out /tmp/hud
 *
 * `--song` is a song id, not a library card to click: the cards' actions are
 * hover-revealed and a click-through races the DataView's own load. A cold player
 * parses the MIDI and boots Pixi before the HUD is up, so the canvas wait is the
 * floor, not a guess.
 */
import { errors } from "playwright";
import type { Page } from "playwright";
import {
  arg,
  numArg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? "/tmp/hud-panels";
/** Rachmaninoff — the same song the look check drives. */
const song = arg("song") ?? "ea7bdc72-1ea0-41cb-a05e-96d506e2a948";
const settleMs = numArg("settle", 60_000);

interface PanelMetrics {
  found: boolean;
  width: number;
  rowLefts: number[];
  rowHeights: number[];
  labelLefts: number[];
  switches: number;
  radioMarks: number;
  checkMarks: number;
  nativeCheckboxes: number;
  nativeRadios: number;
  bands: number;
}

/**
 * Read off the LIVE panel rather than off the source: the rail is a computed
 * custom property resolved through four `:has()` cases, so the only honest way
 * to ask whether two panels share it is to measure both in a real browser.
 */
async function measure(page: Page): Promise<PanelMetrics> {
  return page.evaluate(() => {
    // The LAST visible panel: a popover portals to the end of <body>, and the
    // page may carry other, closed panels mounted by other chrome.
    const panel = [...document.querySelectorAll<HTMLElement>(".cp-panel")]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .at(-1);
    if (!panel) {
      return {
        found: false,
        width: 0,
        rowLefts: [],
        rowHeights: [],
        labelLefts: [],
        switches: 0,
        radioMarks: 0,
        checkMarks: 0,
        nativeCheckboxes: 0,
        nativeRadios: 0,
        bands: 0,
      };
    }
    const round = (n: number) => Math.round(n * 10) / 10;
    const rows = [...panel.querySelectorAll<HTMLElement>(".cp-row")];
    // A row's LABEL is its third grid cell; reading the row box would only
    // report the bleed, which is identical by construction and proves nothing.
    const labelLefts = rows.map((r) => {
      const cells = [...r.children] as HTMLElement[];
      const label = cells.find((c) => c.dataset.cpCell === "label") ?? cells[2];
      return round((label ?? r).getBoundingClientRect().left);
    });
    return {
      found: true,
      width: round(panel.getBoundingClientRect().width),
      rowLefts: rows.map((r) => round(r.getBoundingClientRect().left)),
      rowHeights: rows.map((r) => round(r.getBoundingClientRect().height)),
      labelLefts,
      switches: panel.querySelectorAll('[role="switch"]').length,
      radioMarks: panel.querySelectorAll('[role="radio"]').length,
      checkMarks: panel.querySelectorAll('[role="checkbox"]').length,
      nativeCheckboxes: panel.querySelectorAll('input[type="checkbox"]').length,
      nativeRadios: panel.querySelectorAll('input[type="radio"]').length,
      bands: panel.querySelectorAll(".cp-band").length,
    };
  });
}

const uniq = (ns: number[]) => [...new Set(ns)];

await withBrowser(async (h) => {
  const r = report("sonata-view-vs-fx");
  const { page, captured } = await h.session({
    viewport: { width: 1400, height: 950 },
  });

  await page.goto(pathUrl(`/sonata/song/${song}`), {
    waitUntil: "domcontentloaded",
  });

  let painted = true;
  try {
    await page.waitForSelector("canvas", { timeout: settleMs });
  } catch (err) {
    if (!(err instanceof errors.TimeoutError)) throw err;
    painted = false;
  }
  r.ok("roll canvas mounted", painted, `no <canvas> after ${settleMs}ms`);
  await page.waitForTimeout(2_000);

  const shots: Record<string, PanelMetrics> = {};
  // Both chips carry a real `aria-label` (their visible text is the two-letter
  // pill), so name them by that rather than by what is printed on them.
  const panels = [
    { label: "View", trigger: "Display options" },
    { label: "FX", trigger: "Visual effects" },
  ];
  for (const { label, trigger: triggerName } of panels) {
    const trigger = page.getByRole("button", {
      name: triggerName,
      exact: true,
    });
    await trigger.click();
    await page.waitForTimeout(700);
    const metrics = await measure(page);
    shots[label] = metrics;
    await snap(page, out, label.toLowerCase());
    console.log(`${label}: ${JSON.stringify(metrics)}`);
    // Esc rather than a second click on the trigger: the HUD sits inside the
    // roll's drag surface, and a stray click there scrubs the playhead.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  const view = shots.View!;
  const fx = shots.FX!;

  r.ok(
    "both panels opened",
    view.found && fx.found,
    "a cp-panel never mounted",
  );
  r.ok(
    "same panel width (the `menu` role)",
    view.width === fx.width,
    `View ${view.width}px vs FX ${fx.width}px`,
  );
  for (const [name, m] of [
    ["View", view],
    ["FX", fx],
  ] as const) {
    r.ok(
      `${name}: one rail`,
      uniq(m.labelLefts).length <= 1,
      `label lefts ${JSON.stringify(uniq(m.labelLefts))}`,
    );
    r.ok(
      `${name}: one row height`,
      uniq(m.rowHeights).length <= 1,
      `row heights ${JSON.stringify(uniq(m.rowHeights))}`,
    );
    r.ok(
      `${name}: no UA-drawn selection`,
      m.nativeCheckboxes === 0 && m.nativeRadios === 0,
      `${m.nativeCheckboxes} native checkbox(es), ${m.nativeRadios} native radio(s)`,
    );
  }
  r.ok(
    "the two panels share ONE rail",
    uniq([...view.labelLefts, ...fx.labelLefts]).length <= 1,
    `View ${JSON.stringify(uniq(view.labelLefts))} vs FX ${JSON.stringify(uniq(fx.labelLefts))}`,
  );
  r.ok(
    "the two panels share ONE row height",
    uniq([...view.rowHeights, ...fx.rowHeights]).length <= 1,
    `View ${JSON.stringify(uniq(view.rowHeights))} vs FX ${JSON.stringify(uniq(fx.rowHeights))}`,
  );

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
