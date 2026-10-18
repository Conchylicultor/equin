// Verifies the surface-level `PaneMatchContext` (resolved once by
// `PaneSurfaceProvider`, not by the layout renderer):
//
//  1. Chrome route reads work — the Pages sidebar highlights the open page and
//     the agent-manager sidebar highlights the open conversation. Both live in
//     `AppShellLayout`'s `sidebarContent`, a SIBLING of the layout renderer, so
//     both read `null` and never highlighted while the renderers owned the
//     provider.
//  2. Global chrome still works — the floating action bar renders OUTSIDE every
//     surface, so a match read from there now throws. Every action-bar item is
//     opened in turn and the run fails on any page error or crash fallback.
//  3. The bespoke-surface apps (browser, home, sonata, website) still boot; they
//     now get `setBasePath` + a registry sync from the surface.
//
// Usage:
//   ./singularity run plugins/primitives/plugins/pane/e2e/surface-match.ts \
//     --page <pageId> --conv <conversationId> [--url http://<worktree>.localhost:9000]

import type { Page } from "playwright";
import {
  numArg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { setEditMode } from "@plugins/reorder/plugins/edit-mode/e2e";

const PAGE_ID = requireArg(
  "page",
  "usage: surface-match.ts --page <pageId> --conv <conversationId>",
);
const CONV_ID = requireArg(
  "conv",
  "usage: surface-match.ts --page <pageId> --conv <conversationId>",
);
const OUT = "/tmp/claude-501/surface-match";
const waitMs = numArg("wait", 3500);

const r = report("surface-match");

/**
 * Rows the app marks as the active nav target. Two markers, because the two
 * sidebars render through different primitives: a `Row`-backed list row carries
 * `aria-current`, while a tree row (`TreeRowChrome`) composes a Stack directly
 * and marks selection with the accent background only.
 */
function activeRows(page: Page) {
  return page.locator(
    '[aria-current="true"], [aria-current="page"], .bg-accent',
  );
}

/** The crash fallback the plugin error boundary paints. */
async function crashCount(page: Page): Promise<number> {
  return page.getByText(/Something went wrong|Plugin crashed/i).count();
}

await withBrowser(async (h) => {
  const { page, captured } = await h.session({ colorScheme: "dark" });

  // ---- 1. chrome route reads -------------------------------------------
  await page.goto(pathUrl(`/pages/page/${PAGE_ID}`));
  await page.waitForTimeout(waitMs);
  const pagesActive = await activeRows(page).allInnerTexts();
  // `pageDetailPane` is the route's title owner, so the document title leads
  // with the open page's title — the same string its sidebar row must show.
  const pageTitle = (await page.title()).split("—")[0]!.trim();
  r.ok(
    "pages sidebar highlights the open page",
    pagesActive.some((t) => t.trim() === pageTitle),
    `open page "${pageTitle}"; active rows: ${JSON.stringify(pagesActive)}`,
  );
  await snap(page, OUT, "1-pages-highlight");

  await page.goto(pathUrl(`/agents/c/${CONV_ID}`));
  await page.waitForTimeout(waitMs);
  const convActive = await activeRows(page).allInnerTexts();
  r.ok(
    "agent-manager sidebar highlights the open conversation",
    convActive.length > 0,
    `active rows: ${JSON.stringify(convActive)}`,
  );
  await snap(page, OUT, "2-conversation-highlight");

  // ---- 2. global chrome (outside every surface) -------------------------
  // The floating action bar is the `Core.Root` overlay pinned to the viewport's
  // top-right corner — outside every `PaneSurfaceProvider`, so a match read from
  // one of its items now throws. Reveal it and click each item in turn; each is
  // either a popover or a pane open, and both must survive.
  const barHost = page.locator(".fixed.top-2.right-3").first();
  await barHost.hover();
  await page.waitForTimeout(800);
  const buttons = barHost.locator("button");
  const names: string[] = await buttons.evaluateAll((els) =>
    els.map(
      (e, i) =>
        e.getAttribute("aria-label") ||
        (e.textContent ?? "").trim() ||
        `button-${i}`,
    ),
  );
  r.ok("floating action bar reveals its items", names.length > 0);
  r.note(`action-bar items (${names.length}): ${JSON.stringify(names)}`);
  await snap(page, OUT, "3-action-bar-open");

  for (const [i, name] of names.entries()) {
    // Two items are global MODE switches rather than surfaces, and both break
    // the rest of the sweep if left on: the pin re-hosts the bar into the tab
    // bar (invalidating every locator), and the reorder pen wraps each item in
    // a drag handle that swallows pointer events. They get their own pass below.
    if (/pin action bar|reorder/i.test(name)) continue;
    await barHost.hover();
    await page.waitForTimeout(400);
    const btn = buttons.nth(i);
    // Some entries are zero-size `aria-hidden` popover anchors, not affordances.
    if (!(await btn.isVisible())) continue;
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(1200);
    r.ok(
      `action-bar "${name}" opens without a crash fallback`,
      (await crashCount(page)) === 0,
    );
    r.ok(
      `action-bar "${name}" throws no page error`,
      captured.pageErrors.length === 0,
      JSON.stringify(captured.pageErrors.slice(0, 3)),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
  await snap(page, OUT, "3-action-bar-done");

  // The load-bearing one: opening a PANE from global chrome. The quick-theme
  // popover hands off to the full customizer pane, so this exercises the whole
  // outside-a-surface → openPane path in one click.
  await barHost.hover();
  await page.waitForTimeout(500);
  await barHost.locator('button[aria-label="Theme"]').first().click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Open theme editor" }).first().click();
  await page.waitForTimeout(1800);
  r.ok(
    "theme customizer pane opens from global chrome",
    (await page.locator('[data-pane-id="theme-customizer"]').count()) > 0,
    `url=${page.url()}`,
  );
  r.ok("customizer opened without a crash", (await crashCount(page)) === 0);
  await snap(page, OUT, "3-theme-customizer");

  await page.goto(pathUrl(`/agents/c/${CONV_ID}`));
  await page.waitForTimeout(waitMs);

  // ---- 3. bespoke-surface apps -----------------------------------------
  for (const app of ["browser", "home", "sonata", "website"]) {
    await page.goto(pathUrl(`/${app}`));
    await page.waitForTimeout(waitMs);
    const crashes = await crashCount(page);
    const body = (await page.locator("body").innerText()).trim();
    r.ok(
      `${app} boots`,
      crashes === 0 && body.length > 0,
      `crashes=${crashes}`,
    );
    await snap(page, OUT, `4-${app}`);
  }

  // ---- 4. reorder edit mode, last ---------------------------------------
  // Deliberately the final step: edit mode wraps every reorderable contribution
  // in a drag handle that swallows pointer events, so anything clicked after it
  // would fail for reasons that have nothing to do with the route.
  await page.goto(pathUrl(`/agents/c/${CONV_ID}`));
  await page.waitForTimeout(waitMs);
  await setEditMode(page, true);
  await page.waitForTimeout(1200);
  r.ok(
    "reorder edit mode engages without a crash",
    (await crashCount(page)) === 0,
  );
  await snap(page, OUT, "5-reorder-edit-mode");

  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    JSON.stringify(captured.pageErrors.slice(0, 5)),
  );
});

await r.finish();
