// Photographs every app the website's gallery shows, one PNG per app, so the
// gallery's screenshots can be refreshed whenever an app's design moves.
//
// An app the homepage's live demo carries is photographed IN the demo, at its
// staged `shot` place (`APP_DEMO_PLACES`, the apps page's core): the homepage at
// `/about/at/<place>;full=1`, the demo maximized over the page — the demo's
// own made-up data, never anyone's real one. Every tip the demo raises is answered before
// the shot, so none covers the app.
//
// An app the demo does not carry opens at its own basePath (read from the
// app's descriptor, so a renamed route cannot leave a stale path here) with
// `?embed=1`: the app's own screen, without the rail, tab bar or action bar
// around it — showing whatever data the instance has.
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
  waitForNotBusy,
  withBrowser,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  embedTailPath,
  type AppRef,
} from "@plugins/primitives/plugins/pane/core";
import { APP_DEMO_PLACES } from "@plugins/apps/plugins/website/plugins/pages/plugins/apps/core";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
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
    path: websiteApp.basePath + embedTailPath(shot, { maximized: true }),
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
 * The demo's own chrome over a maximized demo — its "Press Esc to restore"
 * notice (`apps/demo/chrome`) — is not the app: left out of the picture,
 * whenever its fade happens to be.
 */
const DEMO_CHROME_STYLE =
  "[data-demo-esc-notice] { display: none !important; }";
/** How many times, and how far apart, a frame is checked for a tip. */
const TIP_ROUNDS = 4;
const TIP_ROUND_MS = 1500;

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
    await page.addStyleTag({ content: DEMO_CHROME_STYLE });
    await page.waitForTimeout(waitMs);
    // Every loading region done (each `Loading` is aria-busy).
    const settled = await waitForNotBusy(page);
    if (!settled.ok) console.log(`  still busy: ${settled.value.join(", ")}`);
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
