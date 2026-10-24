/**
 * Asserts the two things a pitch layout can actually break, in whichever layout
 * is active: that the keybed under the roll holds the pads that layout declares,
 * and that each pad is still the thing the pointer lands on.
 *
 * It identifies the active layout from the PAD COUNT rather than by driving the
 * View popover — a run therefore never depends on Playwright finding a combobox,
 * and it reports which layout it saw instead of assuming one. Run it once per
 * layout to get the pair (and once per look for the full six):
 *
 *   ./equin build
 *   ./equin run plugins/apps/plugins/sonata/plugins/pitch-layout/e2e/pitch-layout-verify.ts --out /tmp/piano
 *   # switch Keyboard layout → Jankó in the View popover
 *   ./equin run plugins/apps/plugins/sonata/plugins/pitch-layout/e2e/pitch-layout-verify.ts --out /tmp/janko
 *
 * `--song` takes a song id, NOT a library card to click: the cards' actions are
 * hover-revealed, so a click-through has to hover first and still races the
 * DataView's own load. A song URL is the stable entry point, and it needs a
 * generous wait because a cold player parses the MIDI, boots Pixi and installs
 * three bitmap fonts before the first frame.
 */
import { errors, type Page } from "playwright";
import { pitchGeometry } from "@plugins/apps/plugins/sonata/plugins/pitch-layout/core";
import type { PitchLayoutId } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  arg,
  numArg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out") ?? "/tmp/sonata-pitch-layout";
/** Rachmaninoff — dense enough that notes are always on screen. */
const song = arg("song") ?? "ea7bdc72-1ea0-41cb-a05e-96d506e2a948";
const settleMs = numArg("settle", 60_000);

/**
 * The roll's keybed range. A copy of `piano-roll`'s `KEYBOARD_LOW`/`_HIGH`,
 * because an `e2e` script may reach only `core` and `e2e` barrels and those
 * constants live in the roll's `web`. If the roll ever shows a different range,
 * this script reports a layout mismatch rather than going quietly wrong.
 */
const ROLL_LOW = 21;
const ROLL_HIGH = 108;

/**
 * How many pads each layout puts under the roll, and how many distinct pitches
 * they cover. Derived from the geometry itself rather than typed out, so the
 * script asserts what the layout says — and a third layout id is a `tsc` error
 * here until it is listed.
 */
const LAYOUTS: Record<PitchLayoutId, { pads: number; pitches: number }> = {
  piano: shapeOf("piano"),
  janko: shapeOf("janko"),
};

function shapeOf(id: PitchLayoutId) {
  const plane = pitchGeometry(id, ROLL_LOW, ROLL_HIGH);
  return {
    pads: plane.keys.length,
    pitches: new Set(plane.keys.map((k) => k.pitch)).size,
  };
}

/**
 * The keybed under the roll, told apart from the readout chips (which render
 * `[data-pitch]` pads too) by being the biggest cluster on the page: the roll
 * shows the full 88-key range, a chip shows three octaves.
 */
async function readKeybed(page: Page) {
  return page.evaluate(() => {
    const byHost = new Map<Element, HTMLElement[]>();
    for (const el of document.querySelectorAll<HTMLElement>("[data-pitch]")) {
      const host = el.parentElement;
      if (!host) continue;
      const group = byHost.get(host);
      if (group) group.push(el);
      else byHost.set(host, [el]);
    }
    let biggest: HTMLElement[] = [];
    for (const group of byHost.values()) {
      if (group.length > biggest.length) biggest = group;
    }
    const pitches = biggest.map((el) => Number(el.dataset.pitch));
    // Hit-test the pad nearest the middle at its own centre: this is exactly
    // what `usePlayableKeyboard` does on every pointer event, so a pad that
    // fails here is a pad no one can play.
    const probe = biggest[Math.floor(biggest.length / 2)];
    let hit: number | null = null;
    if (probe) {
      const r = probe.getBoundingClientRect();
      const under = document
        .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        ?.closest<HTMLElement>("[data-pitch]");
      hit = under ? Number(under.dataset.pitch) : null;
    }
    return {
      pads: biggest.length,
      distinct: new Set(pitches).size,
      probePitch: probe ? Number(probe.dataset.pitch) : null,
      hit,
    };
  });
}

await withBrowser(async (h) => {
  const r = report("sonata-pitch-layout");
  const { page, captured } = await h.session();

  await page.goto(pathUrl(`/sonata/song/${song}`), {
    waitUntil: "domcontentloaded",
  });

  // Wait for the canvas rather than sleeping: it IS the roll, and its absence is
  // the failure worth naming. Only a TIMEOUT means "it never painted" — that is
  // this script's verdict, reported (not thrown) so the run still captures the
  // shots that show why. Anything else is a broken script and rethrows.
  let painted = true;
  try {
    await page.waitForSelector("canvas", { timeout: settleMs });
  } catch (err) {
    if (!(err instanceof errors.TimeoutError)) throw err;
    painted = false;
  }
  r.ok("roll canvas mounted", painted, `no <canvas> after ${settleMs}ms`);
  await page.waitForTimeout(2_000);
  await snap(page, out, "rest");

  const keybed = await readKeybed(page);
  const active = (Object.keys(LAYOUTS) as PitchLayoutId[]).find(
    (id) => LAYOUTS[id].pads === keybed.pads,
  );
  r.ok(
    "keybed pad count matches a known layout",
    active !== undefined,
    `${keybed.pads} pads matches none of ${Object.entries(LAYOUTS)
      .map(([id, s]) => `${id}=${s.pads}`)
      .join(", ")}`,
  );
  if (active) {
    r.note(`active layout: ${active}`);
    // Every layout covers the same pitches; only the pad count differs. A drift
    // here means the axis gained or lost a note, which is the bug that used to
    // pin a fabricated bar at x=0.
    r.eq("distinct pitches", keybed.distinct, LAYOUTS[active].pitches);
  }

  // Hit-testing: the pad's own centre must resolve to that pad. Glissando and
  // multi-touch read `data-pitch` off `elementFromPoint`, so this is the whole
  // contract in one probe.
  r.eq("pad centre hit-tests to itself", keybed.hit, keybed.probePitch);

  // And it must survive a real click — a pad covered by a decorative layer that
  // forgot `pointer-events-none` passes the probe above and eats this.
  const probe = page.locator(`[data-pitch="${keybed.probePitch}"]`).first();
  await probe.click({ timeout: 5_000 });
  await page.waitForTimeout(300);

  // Playing, so notes are mid-fall and pads are lit — a layout that only
  // survives a still frame is not a layout that survives the app.
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
