/**
 * The extension end to end: Chromium with this checkout's built shell loaded
 * unpacked, a tab on an equin.ai page (served by the script — the action
 * matches on the tab's URL, and the real site is not this build), then the
 * popup opened as a page of its own.
 *
 *   ./equin run plugins/companions/plugins/browser-extension/e2e/popup-probe.ts [--headed]
 *
 * Asserts the popup frames this checkout's deploy and its bridge answers
 * (hostInfo, then the tab), the Wish section renders, Open locally is offered
 * for the equin.ai tab, and running it moves that tab to the same page on the
 * local instance.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flag,
  report,
  targetNamespace,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import { launchPersistentChromium } from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import {
  ConnectionStateSchema,
  EXTENSION_ID,
} from "@plugins/companions/plugins/browser-extension/core";
import {
  browserExtensionRoot,
  CONNECTION_FILE,
  SHELL_DIGEST_FILE,
  SHELL_FOLDER,
} from "@plugins/companions/plugins/browser-extension/data-dirs";

const PUBLIC_PAGE = "https://equin.ai/about/guide";
const LOCAL_PAGE = "http://equin.localhost:9000/about/guide";
const TIMEOUT_MS = 60_000;

const r = report("browser extension popup");
const root = browserExtensionRoot(targetNamespace());
const shell = join(root, SHELL_FOLDER);
console.log(`shell: ${shell}`);

const installed = await ensureDepViaCli(chromium, {
  stdio: "inherit",
  grant: null,
});
const profile = await mkdtemp(join(tmpdir(), "equin-extension-probe-"));
// The headed binary: the headless shell runs no extensions. Headless unless
// --headed, in Chrome's own (new) headless mode, which does.
const context = await launchPersistentChromium(installed, profile, {
  signals: "playwright",
  headless: false,
  args: [
    ...(flag("headed") ? [] : ["--headless=new"]),
    `--disable-extensions-except=${shell}`,
    `--load-extension=${shell}`,
  ],
});
try {
  // A stand-in for the published page: only its URL matters to the action.
  await context.route("https://equin.ai/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>The guide · equin</title><h1>The guide</h1>",
    }),
  );
  const tab = context.pages()[0] ?? (await context.newPage());
  await tab.goto(PUBLIC_PAGE);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  const panel = popup.frameLocator("iframe");

  // The composer's placeholder is drawn text (a rich-text editor), not an
  // input's placeholder attribute.
  const wish = panel.getByText("Fix, change or build anything…", {
    exact: true,
  });
  await wish.waitFor({ timeout: TIMEOUT_MS });
  r.ok("the popup frames the panel and the Wish field renders", true);

  const openLocally = panel.getByText("Open locally", { exact: true });
  await openLocally.waitFor({ timeout: TIMEOUT_MS });
  r.ok(
    "the bridge answered (hostInfo, then the tab): Open locally is offered for equin.ai",
    true,
  );
  r.ok(
    "the panel is not the plain-tab state",
    (await panel
      .getByText("This page runs inside the equin browser extension")
      .count()) === 0,
  );

  // The open was recorded for Settings, on the shell that is served.
  const served = (await readFile(join(root, SHELL_DIGEST_FILE), "utf8")).trim();
  const recorded = ConnectionStateSchema.parse(
    JSON.parse(await readFile(join(root, CONNECTION_FILE), "utf8")),
  );
  r.ok(
    "the popup recorded its open, on the served shell",
    recorded.kind === "seen" &&
      recorded.shellDigest === served &&
      Date.now() - recorded.seenAt < TIMEOUT_MS * 3,
    JSON.stringify(recorded),
  );

  await openLocally.click();
  await tab.waitForURL(LOCAL_PAGE, { timeout: TIMEOUT_MS });
  r.eq("Open locally moved the tab to the local page", tab.url(), LOCAL_PAGE);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
await r.finish();
