// Photographs every app the website's gallery shows, one PNG per app, so the
// gallery's screenshots can be refreshed whenever an app's design moves.
//
// An app the homepage's live demo carries is photographed IN the demo, at its
// staged `shot` place (`APP_DEMO_PLACES`, the apps page's core): the demo page
// at `/about/demo/at/<place>`, the demo alone filling the page — the demo's
// own made-up data, never anyone's real one. Every tip the demo raises is answered before
// the shot, so none covers the app.
//
// An app the demo does not carry opens at its own basePath (read from the
// app's descriptor, so a renamed route cannot leave a stale path here) with
// `?embed=1`: the app's own screen, without the rail, tab bar or action bar
// around it — showing whatever data the instance has.
//
// A place a URL cannot stage has a SETUP step, run on the settled frame before
// the shot: the desktop opens two more apps from its shelf and lays the
// windows out; the island presses its title card's Start.
//
// Toasts never reach the image (snap's hideToasts); what each one said is
// logged as TOAST-HIDDEN, since an error toast is still a bug worth reading.
//
// Shoot main (`--url http://equin.localhost:9000`): an agent worktree's
// deploy wears the red "experimental" frame, and the demo is the same there.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/e2e/app-screenshots.ts \
//     --out <dir> [--url http://equin.localhost:9000] [--only sonata,maps] \
//     [--viewport 1440x900] [--color-scheme dark|light] [--wait 8000]
//
// Writes `<dir>/app-<gallery id>.png` (the catalog's ids). Look at every image
// before publishing it — an instance-shot app shows whatever its data is.

import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import {
  arg,
  numArg,
  pathUrl,
  requireArg,
  snap,
  withBrowser,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitForNotBusy } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { demoPagePath } from "@plugins/apps/plugins/website/plugins/live-demo/core";
import { APP_DEMO_PLACES } from "@plugins/apps/plugins/website/plugins/pages/plugins/apps/core";
import { browserApp } from "@plugins/apps/plugins/browser/plugins/shell/core";
import { chordApp } from "@plugins/apps/plugins/chord/plugins/shell/core";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { eventsApp } from "@plugins/apps/plugins/events/plugins/shell/core";

/**
 * The gallery's apps the demo does not carry, by gallery id: shot on the
 * instance. The demo's own come from `APP_DEMO_PLACES`.
 */
const INSTANCE_APPS: Readonly<Record<string, AppRef>> = {
  deploy: deployApp,
  events: eventsApp,
  chord: chordApp,
  browser: browserApp,
};

/** Each gallery app and the path that shows it. */
const GALLERY: { id: string; path: string }[] = [
  ...Object.entries(APP_DEMO_PLACES).map(([id, { shot }]) => ({
    id,
    path: demoPagePath(shot),
  })),
  ...Object.entries(INSTANCE_APPS).map(([id, app]) => ({
    id,
    path: `${app.basePath}?embed=1`,
  })),
];

const outDir = requireArg("out", "--out <dir>").replace(/\/+$/, "");
const only = arg("only")?.split(",");
const [width = 1440, height = 900] = arg("viewport", "1440x900")
  .split("x")
  .map(Number);
const colorScheme = arg("color-scheme", "dark") as ColorScheme;
// The demo boots a worker on its first frame: give each frame time to settle.
const waitMs = numArg("wait", 8000);

const shots = only ? GALLERY.filter((a) => only.includes(a.id)) : GALLERY;
const unknown = only?.filter((id) => !GALLERY.some((a) => a.id === id)) ?? [];
if (unknown.length) {
  throw new Error(
    `--only names apps the gallery does not show: ${unknown.join(", ")} (known: ${GALLERY.map((a) => a.id).join(", ")})`,
  );
}

/**
 * The demo page's own chrome — its "Back to equin" pill
 * (`landing/screenshot/chrome`, shown only after a Maximize, never on a
 * page opened directly as here) — is not the app: left out of the picture
 * should it ever show.
 */
const DEMO_CHROME_STYLE = "[data-demo-back] { display: none !important; }";
/**
 * The site's cookie consent prompt (`pages/privacy`) asks every fresh
 * visitor, the screenshot's browser included: left out of the picture
 * rather than answered, so the run records no consent.
 */
const CONSENT_STYLE =
  '[aria-label="Cookie consent"] { display: none !important; }';
/** How many times, and how far apart, a frame is checked for a tip. */
const TIP_ROUNDS = 4;
const TIP_ROUND_MS = 1500;

/**
 * A desktop window (`apps/desktop/windows`) — not the copy of one a shelf
 * thumbnail draws (`WindowSnapshot`), which carries the same id.
 */
const WINDOW =
  "[data-floating-window-id]:not([data-window-snapshot] [data-floating-window-id])";

/**
 * Open `app` from the desktop's shelf as a new window and drag it by its
 * titlebar so its top-left corner lands at `to` — the window the click added,
 * told apart from the ones already open by its id.
 */
async function openWindowAt(
  page: Page,
  app: string,
  to: { x: number; y: number },
): Promise<void> {
  const ids = async () =>
    page
      .locator(WINDOW)
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-floating-window-id")),
      );
  const before = new Set(await ids());
  await page.getByRole("button", { name: app, exact: true }).first().click();
  await page.waitForFunction(
    ([selector, open]) => document.querySelectorAll(selector).length > open,
    [WINDOW, before.size] as const,
  );
  const added = (await ids()).find((id) => !before.has(id));
  if (!added) throw new Error(`the shelf's ${app} opened no new window`);
  const win = page
    .locator(WINDOW)
    .and(page.locator(`[data-floating-window-id="${added}"]`));
  await page.waitForTimeout(1500);
  const box = await win.boundingBox();
  if (!box) throw new Error(`the ${app} window has no box`);
  // An empty stretch of the titlebar, left of its window controls.
  const grab = { x: box.x + box.width - 260, y: box.y + 20 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  const end = { x: to.x + box.width - 260, y: to.y + 20 };
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/**
 * The staging a place's URL cannot express, by gallery id: run on the
 * settled frame, before its tips are answered and the shot taken.
 */
const SETUP: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  // The `shot` URL opens Sonata as the first window; two more apps join it,
  // overlapping as windows do, the wallpaper and the shelf still showing.
  desktop: async (page) => {
    await openWindowAt(page, "Pages", { x: 560, y: 24 });
    await openWindowAt(page, "Agent Manager", { x: 520, y: 226 });
  },
  // The island opens on its title card: Start walks into the world.
  isle: async (page) => {
    // Its Start breathes (an endless animation), so it is never "stable".
    await page
      .getByRole("button", { name: "Start", exact: true })
      .click({ force: true });
    await page.waitForTimeout(4000);
  },
};

/** A contextual tip's Got it, while its card shows (the hints stage). */
const SHOWN_TIP_BUTTON =
  '.hint-card[data-variant="tip"][data-on="true"] button';

/**
 * Answer every tip that shows over a few seconds: the demo's seen state is
 * fresh, so its tips come one after another, each waiting its turn and for a
 * pause in input (hints' tip queue) — a frame with none up yet may still get
 * one. Each round leaves time for a card's fade to end before the shot.
 */
async function dismissTips(page: Page): Promise<void> {
  for (let round = 0; round < TIP_ROUNDS; round++) {
    const answered = await page.evaluate((selector) => {
      const buttons = [...document.querySelectorAll<HTMLElement>(selector)];
      for (const button of buttons) button.click();
      return buttons.length;
    }, SHOWN_TIP_BUTTON);
    if (answered > 0) console.log(`  answered ${answered} tip(s)`);
    await page.waitForTimeout(TIP_ROUND_MS);
  }
}

mkdirSync(outDir, { recursive: true });

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width, height },
    colorScheme,
  });
  const failed: string[] = [];
  for (const shot of shots) {
    console.log(`${shot.id}: ${shot.path}`);
    await page.goto(pathUrl(shot.path));
    await page.addStyleTag({ content: DEMO_CHROME_STYLE + CONSENT_STYLE });
    await page.waitForTimeout(waitMs);
    // Every loading region done (each `Loading` is aria-busy).
    const settled = await waitForNotBusy(page);
    if (!settled.ok) console.log(`  still busy: ${settled.value.join(", ")}`);
    const setup = SETUP[shot.id];
    if (setup) await setup(page);
    await dismissTips(page);
    const result = await snap(page, `${outDir}/app`, shot.id, {
      hideToasts: true,
    });
    if (!result.ok) failed.push(shot.id);
  }
  if (failed.length) {
    console.error(`failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
});
