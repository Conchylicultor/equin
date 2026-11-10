/**
 * The homepage's live demo band, on a first visit (a fresh browser holds no
 * demo data):
 *  1. it opens on the gate (Enter equin), and nothing of the demo's host —
 *     its host module, its worker — is requested before the click;
 *  2. Enter grows the frame in place, out of the reading measure, and the
 *     boot screen's bar shows while the host starts;
 *  3. the demo runs (the embed renders) with Maximize / Collapse / Reset demo
 *     under it;
 *  4. Maximize draws the demo over the tab's surface (above the site's
 *     header), Restore (revealed at the top edge) brings it back into its
 *     frame; Collapse returns the frame to the measure.
 * Screenshots of each step go to `--out`.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/website/plugins/landing/plugins/screenshot/e2e/live-demo.ts [--out /tmp/website-live-demo] [--headed]
 */
import type { Request } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/website-live-demo";
/** The demo's host: its module (`@browser-host/…`) and its worker tree. */
const HOST_REQUEST = /\/(artifacts\/[^/]*browser-host|artifacts\/worker-tree)/;
const BOOT_TIMEOUT_MS = 60_000;

await withBrowser(async (h) => {
  const r = report("website: the homepage's live demo, downloaded on demand");
  const { page } = await h.session();
  const hostRequests: string[] = [];
  page.on("request", (req: Request) => {
    if (HOST_REQUEST.test(req.url())) hostRequests.push(req.url());
  });

  await page.goto(pathUrl("/website"), { waitUntil: "domcontentloaded" });
  const band = page.locator("figure.website-demo").first();
  const frame = band.locator(".website-demo-frame").first();
  const gate = page.getByRole("button", { name: /Enter equin/ });
  await gate.waitFor({ timeout: BOOT_TIMEOUT_MS });
  await band.scrollIntoViewIfNeeded();
  const before = (await frame.boundingBox())?.width ?? 0;
  await snap(page, OUT, "1-gate");
  r.ok(
    "the band opens on the gate, and nothing of the demo's host was requested",
    hostRequests.length === 0,
    hostRequests.join(", "),
  );

  await gate.click();
  const grown = await waitFor(
    async () => (await frame.boundingBox())?.width ?? 0,
    (w) => w > before + 100,
    { timeoutMs: 5_000 },
  );
  r.ok(
    "Enter grows the frame out of the reading measure",
    grown.ok,
    `${Math.round(before)} → ${Math.round(grown.value)} px`,
  );
  const bar = page.getByRole("progressbar").first();
  if (await bar.isVisible()) await snap(page, OUT, "2-starting");

  const running = await waitFor(
    async () => page.locator("[data-app-embed]").count(),
    (n) => n > 0,
    { timeoutMs: BOOT_TIMEOUT_MS },
  );
  r.ok("the demo runs in the band", running.ok);
  r.ok(
    "the host was requested only after Enter",
    hostRequests.length > 0,
    `${hostRequests.length} request(s)`,
  );
  await page.waitForTimeout(700);
  await snap(page, OUT, "3-running");

  await page.getByRole("button", { name: "Maximize" }).click();
  const viewport = page.viewportSize();
  // Maximized, the demo is drawn over the tab's surface (above the site's
  // header), the frame keeping its place in the page.
  const overlay = page.locator("[data-website-demo-maximized]").first();
  const maximized = await waitFor(
    async () => (await overlay.boundingBox()) ?? null,
    (box) =>
      box !== null &&
      viewport !== null &&
      Math.abs(box.width - viewport.width) < 2 &&
      box.y < 2,
    { timeoutMs: 3_000 },
  );
  r.ok(
    "Maximize fills the tab, the site's header included",
    maximized.ok,
    JSON.stringify(maximized.value),
  );
  r.ok(
    "the maximized demo runs (the embed remounted inside it)",
    (await overlay.locator("[data-app-embed]").count()) > 0,
  );
  await snap(page, OUT, "4-maximized");
  await page.mouse.move((viewport?.width ?? 1200) / 2, 2);
  await page.getByRole("button", { name: "Restore" }).click();
  const restored = await waitFor(
    async () => ({
      overlays: await overlay.count(),
      embeds: await frame.locator("[data-app-embed]").count(),
    }),
    (v) => v.overlays === 0 && v.embeds > 0,
    { timeoutMs: 3_000 },
  );
  r.ok(
    "Restore puts the demo back in its frame",
    restored.ok,
    JSON.stringify(restored.value),
  );

  await page.getByRole("button", { name: "Collapse" }).click();
  const collapsed = await waitFor(
    async () => (await frame.boundingBox())?.width ?? 0,
    (w) => Math.abs(w - before) < 2,
    { timeoutMs: 3_000 },
  );
  r.ok(
    "Collapse returns it to the reading measure",
    collapsed.ok,
    `${Math.round(collapsed.value)} px`,
  );
  await snap(page, OUT, "5-collapsed");
  await r.finish();
});
