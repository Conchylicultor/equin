// Scripted end-to-end check for the tri-state pane route + settled-and-healthy
// fallback gating (research/2026-07-08-global-tristate-pane-route.md).
//
// Drives a real deployed worktree and asserts the three behaviors the tri-state
// route exists to guarantee:
//
//   (a) COLD deep link  — opening `/pages/page/<id>` cold renders the page pane,
//       NOT the index/welcome, and leaves the URL untouched (the old bug rewrote
//       it to the homepage or destroyed it).
//   (b) RELOAD restore   — a plain reload restores the same deep link (URL intact,
//       page content present) rather than falling back to the index.
//   (c) BARE `/` redirect — the bare root still canonicalizes to the default app.
//
// Manual, self-contained — NOT wired into any check (tests are manual here):
//
//   ./equin run plugins/primitives/plugins/pane/e2e/deep-link-restore.ts \
//     --page-id block-1781024618461-ud10ib [--url <deploy>] [--wait <ms>]
//
// Exit 0 = all pass; exit 1 = a failing assertion (with a printed reason).
import {
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const pageId = requireArg(
  "page-id",
  "Usage: bun plugins/primitives/plugins/pane/e2e/deep-link-restore.ts --page-id <pageId> [--url <deploy>] [--wait <ms>]",
);
// Ceiling, not a fixed sleep: settle() polls and returns as soon as the marker
// appears. Generous because a cold deferred tier under host contention can take
// >8s to hydrate (the `load` event can hang outright on the app's long-lived
// connections, so navigations use waitUntil:"commit" + polling instead).
const waitMs = numArg("wait", 20000);

const deepPath = `/pages/page/${pageId}`;
const deepUrl = pathUrl(deepPath);

const r = report();

interface Snapshot {
  pathname: string;
  notFound: boolean;
  appError: boolean;
  hasEditor: boolean;
  title: string;
}

/** Read a compact snapshot of the current page state for assertions + logging. */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => ({
    pathname: location.pathname,
    notFound: /doesn't exist/i.test(document.body.innerText),
    appError: /couldn't load/i.test(document.body.innerText),
    // The page editor mounts a Lexical contenteditable surface; the welcome /
    // index pane does not — a stable "the page pane actually rendered" marker.
    hasEditor: !!document.querySelector('[contenteditable="true"]'),
    title: document.title,
  }));
}

/** Poll until `probe` returns true or the ceiling elapses; never throws. */
async function settle(page: Page, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await page.evaluate(probe)) return;
    if (Date.now() > deadline) return;
    await page.waitForTimeout(250);
  }
}

const editorPresent = (): boolean =>
  !!document.querySelector('[contenteditable="true"]');

await withBrowser(async (h) => {
  const { page } = await h.session();

  // (a) COLD deep link.
  await page.goto(deepUrl, { waitUntil: "commit" });
  await settle(page, editorPresent);
  const cold = await snapshot(page);
  console.log("cold:", JSON.stringify(cold));
  r.ok(
    "cold deep link keeps the URL (not rewritten to the index)",
    cold.pathname === deepPath,
    `pathname=${cold.pathname} (want ${deepPath})`,
  );
  r.ok("cold deep link is not the NotFound surface", !cold.notFound);
  r.ok("cold deep link is not the app-load-error surface", !cold.appError);
  r.ok("cold deep link renders the page pane (editor present)", cold.hasEditor);

  // (b) RELOAD restore — a plain reload must land back on the same deep link.
  await page.reload({ waitUntil: "commit" });
  await settle(page, editorPresent);
  const reloaded = await snapshot(page);
  console.log("reloaded:", JSON.stringify(reloaded));
  r.ok(
    "reload restores the deep link URL",
    reloaded.pathname === deepPath,
    `pathname=${reloaded.pathname} (want ${deepPath})`,
  );
  r.ok("reload renders the page pane (editor present)", reloaded.hasEditor);
  r.ok("reload is not the NotFound surface", !reloaded.notFound);

  // (c) BARE `/` redirects to the default app.
  await page.goto(pathUrl("/"), { waitUntil: "commit" });
  await settle(page, () => location.pathname !== "/");
  const bare = await snapshot(page);
  console.log("bare:", JSON.stringify(bare));
  r.ok(
    "bare / redirects to the default app (pathname no longer '/')",
    bare.pathname !== "/",
    `pathname=${bare.pathname}`,
  );

  await r.finish();
});
