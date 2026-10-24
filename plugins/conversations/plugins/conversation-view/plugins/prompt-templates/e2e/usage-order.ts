/**
 * Verifies the two halves of most-used ordering for the prompt-template chips:
 *
 *  1. **The freeze.** Using a template must NOT move it while the user is still
 *     in the same conversation — a chip that jumps out from under the cursor the
 *     instant it is clicked makes clicking two in a row a guessing game. This is
 *     the assertion that would silently regress if `useUsageOrder`'s ref snapshot
 *     were ever replaced by a plain derived sort.
 *  2. **The reorder.** A reload (a fresh resnapshot) must surface the used
 *     template first.
 *
 * Run against the current worktree's own deploy:
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/prompt-templates/e2e/usage-order.ts --conv <id>
 *
 * `--clicks` must exceed the current leader's decayed score for assertion 2 to
 * mean anything; the default is deliberately generous.
 */
import type { Page } from "playwright";
import {
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

// This repo's host runs many concurrent agent builds; load average routinely
// sits above 20, and the SPA's first paint has been observed past 60s. Every
// timeout here is sized for a contended box, not a quiet one — a flaky verifier
// is worse than a slow one.
const NAV_TIMEOUT_MS = 180_000;
const MOUNT_TIMEOUT_MS = 180_000;
// The point resource hydrates one round-trip after mount; measured at ~5s with
// the host at load 29, so allow generous headroom before reading the order.
const SETTLE_MS = 15_000;

/**
 * The PINNED strip's ✎ buttons — the only one of each chip's pair carrying the
 * title in a `<span>` (the ➤ send button is icon-only).
 *
 * Each pinned chip is now mounted exactly ONCE (`adaptive-bar` measures the real
 * node instead of rendering a hidden full-width twin), so the only other copy in
 * the document is the genuine second surface: the collapsed `FloatingAction`
 * panel, which holds EVERY template — not just the pinned ones — inside a
 * `max-w-6` box, so its clipped chips overlap the strip and intercept clicks
 * aimed at it. `[hidden]` covers the bar's own parking dock, where a chip the
 * strip has no room for is kept alive off-layout.
 *
 * Both exclusions are DESCENDANT selectors (`:not([x] *)`), not attribute checks
 * on the button itself: `inert` sits on the panel wrapper and `hidden` on the
 * dock, several levels above the chip.
 */
const LIVE_CHIP =
  'button[data-ui-owner^="TemplateChip@"]:not([inert] *):not([hidden] *)';

function chipButtons(page: Page) {
  return page.locator(LIVE_CHIP);
}

/** The pinned chips' titles, left to right. */
async function pinnedTitles(page: Page): Promise<string[]> {
  return chipButtons(page).locator("span").allInnerTexts();
}

async function openConversation(page: Page, convId: string): Promise<void> {
  await page.goto(pathUrl(`/agents/c/${convId}`), {
    timeout: NAV_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });
  await chipButtons(page)
    .first()
    .waitFor({ state: "visible", timeout: MOUNT_TIMEOUT_MS });
}

await withBrowser(async (h) => {
  const r = report("prompt-templates usage ordering");
  const convId = requireArg(
    "conv",
    "usage-order.ts --conv <conversationId> [--clicks <n>]",
  );
  const clicks = numArg("clicks", 8);

  const { page } = await h.session({ viewport: { width: 1920, height: 1080 } });
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  await openConversation(page, convId);
  await page.waitForTimeout(SETTLE_MS);

  const before = await pinnedTitles(page);
  r.note(`pinned before: ${before.join(" | ")}`);
  r.ok(
    "pinned strip rendered",
    before.length > 1,
    `got ${before.length} chips`,
  );

  // The LAST pinned chip: guaranteed not to be leading already, so "it leads
  // afterwards" is a real assertion rather than a tautology.
  const target = before.at(-1) ?? "";
  r.note(`target: "${target}" (${clicks} clicks)`);

  for (let i = 0; i < clicks; i++) {
    // The ✎ (insert-into-draft) button, never the ➤ (send) button: this must not
    // send a turn into a live conversation.
    await chipButtons(page).filter({ hasText: target }).first().click();
  }
  await page.waitForTimeout(SETTLE_MS);

  const afterClick = await pinnedTitles(page);
  r.eq("order is frozen within the conversation", afterClick, before);

  await page.reload({ timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  await chipButtons(page)
    .first()
    .waitFor({ state: "visible", timeout: MOUNT_TIMEOUT_MS });
  // The first paint is seeded from the persistent-draft order cache; the settled
  // point-resource read lands a round-trip later.
  await page.waitForTimeout(SETTLE_MS);

  const afterReload = await pinnedTitles(page);
  r.note(`pinned after reload: ${afterReload.join(" | ")}`);
  r.eq(`"${target}" leads after a resnapshot`, afterReload[0], target);
  r.eq("the pinned set is the same size", afterReload.length, before.length);

  await r.finish();
});
