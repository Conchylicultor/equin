// Photographs every app the website's gallery shows, one PNG per app, so the
// gallery's screenshots can be refreshed whenever an app's design moves.
//
// Each app opens at its own basePath (read from the app's descriptor, so a
// renamed route cannot leave a stale path here) with `?embed=1`: the app's own
// screen, without the rail, tab bar or action bar around it. Toasts never reach
// the image (snap's hideToasts); what each one said is logged as TOAST-HIDDEN,
// since an error toast is still a bug worth reading.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/e2e/app-screenshots.ts \
//     --out <dir> [--url http://singularity.localhost:9000] [--only pages,sonata] \
//     [--viewport 1440x900] [--color-scheme dark|light] [--wait 4000]
//
// Writes `<dir>/app-<app-id>.png`. Without --url it shoots this checkout's own
// deploy; pass main's URL to photograph the app with real data in it — and look
// at every image before publishing it, since it shows whatever that data is.

import { mkdirSync } from "node:fs";
import {
  arg,
  numArg,
  pathUrl,
  requireArg,
  snap,
  withBrowser,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { browserApp } from "@plugins/apps/plugins/browser/plugins/shell/core";
import { chordApp } from "@plugins/apps/plugins/chord/plugins/shell/core";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { eventsApp } from "@plugins/apps/plugins/events/plugins/shell/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { pagesApp } from "@plugins/apps/plugins/pages/plugins/shell/core";
import { prototypesApp } from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";

/** The gallery's apps, in its order: a curated list, not every installed app. */
const GALLERY = [
  agentManagerApp,
  prototypesApp,
  deployApp,
  pagesApp,
  sonataApp,
  eventsApp,
  chordApp,
  browserApp,
  fileExplorerApp,
];

const outDir = requireArg("out", "--out <dir>").replace(/\/+$/, "");
const only = arg("only")?.split(",");
const [width = 1440, height = 900] = arg("viewport", "1440x900")
  .split("x")
  .map(Number);
const colorScheme = arg("color-scheme", "dark") as ColorScheme;
const waitMs = numArg("wait", 4000);

const apps = only ? GALLERY.filter((a) => only.includes(a.id)) : GALLERY;
const unknown = only?.filter((id) => !GALLERY.some((a) => a.id === id)) ?? [];
if (unknown.length) {
  throw new Error(
    `--only names apps the gallery does not show: ${unknown.join(", ")} (known: ${GALLERY.map((a) => a.id).join(", ")})`,
  );
}

mkdirSync(outDir, { recursive: true });

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width, height },
    colorScheme,
  });
  const failed: string[] = [];
  for (const app of apps) {
    await page.goto(pathUrl(`${app.basePath}?embed=1`));
    await page.waitForTimeout(waitMs);
    const shot = await snap(page, `${outDir}/app`, app.id, {
      hideToasts: true,
    });
    if (!shot.ok) failed.push(app.id);
  }
  if (failed.length) {
    console.error(`failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
});
