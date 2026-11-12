/**
 * A boot that throws before the app renders says so — never an endless
 * "Loading the app…".
 *
 * Incident 2026-11-12: equin.ai opened from Instagram (Android System WebView,
 * no `SharedWorker`) sat on "Loading the app…" forever: the page transport's
 * `SharedWebSocket` threw at boot, inside a fire-and-forget async block, so the
 * boot screen never left its `loading-code` phase and nothing was reported.
 *
 * Here `SharedWorker` is deleted before any page script runs; the boot screen
 * must turn `crashed` ("Couldn't start the app", the error in its text, Retry).
 *
 *   ./equin run plugins/framework/plugins/web-core/e2e/boot-crash.ts [--out "$EQUIN_SCRATCH/boot-crash"]
 */
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const r = report("boot crash shows an error, not an endless loading screen");
const out = arg("out", "/tmp/boot-crash");

const BOOT = "[data-boot-state]";

await withBrowser(async (h) => {
  // The page logs and reports the boot crash on purpose: not a capture failure.
  const { page } = await h.session({
    label: "no-shared-worker",
    capture: false,
  });
  await page.addInitScript(() => {
    // Like an Android WebView: the API is absent, not broken.
    delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
  });
  await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });
  await page
    .locator(`${BOOT}[data-boot-state="crashed"]`)
    .waitFor({ state: "attached", timeout: 30_000 });
  const text = (await page.locator(BOOT).innerText()).replace(/\s+/g, " ");
  r.note(`boot screen: ${text}`);
  r.ok("says the app couldn't start", text.includes("Couldn't start the app"));
  r.ok("names the cause", text.includes("SharedWorker"), text);
  r.ok(
    "offers Retry",
    (await page.getByRole("button", { name: "Retry" }).count()) === 1,
  );
  await snap(page, out, "crashed");
  await r.finish();
});
