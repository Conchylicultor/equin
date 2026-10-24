/**
 * Captures the roll in whichever look is active, and asserts the thing a look
 * change can actually break: that the Pixi scene still mounts and paints.
 *
 * Run it once per look to get the pair — the switch itself lives in the View
 * popover (`Sonata.ViewOption` → `FieldRenderer`), and driving it from here
 * would be testing Playwright's ability to find a combobox rather than testing
 * the roll:
 *
 *   ./equin build
 *   ./equin run plugins/apps/plugins/sonata/plugins/look/e2e/look-verify.ts --out /tmp/flat
 *   # switch Look → Sketch in the app
 *   ./equin run plugins/apps/plugins/sonata/plugins/look/e2e/look-verify.ts --out /tmp/sketch
 *
 * `--song` takes a song id, NOT a library card to click: the cards' actions are
 * hover-revealed, so a click-through has to hover first and still races the
 * DataView's own load — and when it silently lands on a text node instead, the
 * run fails much later at the canvas wait, pointing at the wrong thing. A song
 * URL is the stable entry point. It just needs a generous wait, because a cold
 * player parses the MIDI, boots Pixi and installs three bitmap fonts before the
 * first frame.
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

const out = arg("out") ?? "/tmp/sonata-look";
/** Rachmaninoff — dense enough that notes are always on screen. */
const song = arg("song") ?? "ea7bdc72-1ea0-41cb-a05e-96d506e2a948";
// A cold player under a loaded host regularly needs ~25s before the first
// frame, so the default is generous on purpose: a too-short wait here reports
// "the roll never mounted", which is exactly the alarm this script exists to
// raise and the last one you want crying wolf.
const settleMs = numArg("settle", 60_000);

await withBrowser(async (h) => {
  const r = report("sonata-look");
  const { page, captured } = await h.session();

  await page.goto(pathUrl(`/sonata/song/${song}`), {
    waitUntil: "domcontentloaded",
  });

  // Wait for the canvas itself rather than sleeping: it IS the subject, and its
  // absence is the failure worth naming. A crashed display still renders the
  // toolbar and the section column, so a screenshot alone reads as "slow".
  //
  // Only a TIMEOUT means "it never painted" — that is this script's verdict, and
  // it is reported rather than thrown so the run still captures the shots that
  // show WHY. Anything else (a closed page, a bad selector) is a broken script,
  // not a failing app, and rethrows.
  let painted = true;
  try {
    await page.waitForSelector("canvas", { timeout: settleMs });
  } catch (err) {
    if (!(err instanceof errors.TimeoutError)) throw err;
    painted = false;
  }
  r.ok("roll canvas mounted", painted, `no <canvas> after ${settleMs}ms`);
  await page.waitForTimeout(2_000);
  await snap(page, out, "roll");

  // Playing, so notes are mid-fall and keys are lit — a look that only survives
  // a still frame is not a look that survives the app.
  await page.keyboard.press("Space");
  await page.waitForTimeout(2_500);
  await snap(page, out, "playing");

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
