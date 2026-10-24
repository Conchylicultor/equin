// Auto-generated page icons, end to end on a deployed build.
//
//  1. A fresh page shows the document glyph (no icon).
//  2. Type a title and a body; ~10 s after the edits settle Haiku picks an
//     emoji, which shows in the sidebar AND the header.
//  3. Pick another emoji in the picker, edit the content, wait past the
//     debounce: the pick is not overwritten (generation ran once).
//  4. Regenerate (picker footer): the icon changes.
//  5. Remove, edit, wait: the icon stays empty.
//
// The page is trashed at the end, whatever happened.
//
// Usage:
//   ./equin run plugins/apps/plugins/pages/plugins/auto-icon/e2e/auto-icon-verify.ts \
//     [--settle 60000] [--headed]

import type { Page } from "playwright";
import {
  agentFetch,
  numArg,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

// Debounce (10 s) + one Haiku call, with room for a loaded machine.
const settleMs = numArg("settle", 60_000);
// Long enough for an edit-triggered run to have fired (debounce 10 s) and done.
const QUIET_MS = 20_000;

const TITLE = "Sourdough baking notes";
const BODY =
  "Starter feeding schedule, hydration ratios, and the overnight proof that finally gave an open crumb.";
const PICKED = "🌵";

interface PageRow {
  id: string;
  data: { icon?: string | null; title?: string };
}

async function iconOf(pageId: string): Promise<string | null> {
  const res = await agentFetch("/api/pages");
  if (!res.ok) throw new Error(`GET /api/pages: HTTP ${res.status}`);
  const rows = (await res.json()) as PageRow[];
  const row = rows.find((r) => r.id === pageId);
  if (!row) throw new Error(`page ${pageId} not in /api/pages`);
  return row.data.icon ?? null;
}

async function waitForIcon(
  page: Page,
  pageId: string,
  done: (icon: string | null) => boolean,
): Promise<string | null> {
  const deadline = Date.now() + settleMs;
  let icon = await iconOf(pageId);
  while (!done(icon) && Date.now() < deadline) {
    await page.waitForTimeout(1000);
    icon = await iconOf(pageId);
  }
  return icon;
}

// How many rendered emoji glyphs (EmojiGlyph's inner span) show exactly `emoji`.
function glyphCount(page: Page, emoji: string): Promise<number> {
  return page.evaluate(
    (e) =>
      [
        ...document.querySelectorAll<HTMLElement>("span[aria-hidden] > span"),
      ].filter((s) => s.textContent === e).length,
    emoji,
  );
}

async function typeInBody(page: Page, text: string): Promise<void> {
  const block = page.locator('[data-block-id] [contenteditable="true"]').last();
  await block.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text, { delay: 5 });
}

const HEADER_ICON = '[aria-label="Change page icon"]';

const r = report("pages auto-icon");

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  const { pageId } = await openBlankPage(page, { settleMs: 2000 });
  console.log(`pageId: ${pageId}`);
  try {
    // 1. No icon yet: the header shows "Add icon", not the big icon button.
    r.eq("new page has no icon", await iconOf(pageId), null);
    r.eq(
      "header shows no icon button",
      await page.locator(HEADER_ICON).count(),
      0,
    );

    // 2. Title + body → an emoji after the debounce.
    await page.keyboard.type(BODY, { delay: 5 });
    await page.locator('[aria-label="Page title"]').fill(TITLE);
    await page.locator('[aria-label="Page title"]').press("Tab");
    const generated = await waitForIcon(page, pageId, (i) => i !== null);
    r.ok("an emoji was generated", generated !== null, "icon stayed null");
    if (generated === null) return;
    r.note(`generated: ${generated}`);
    await page.waitForTimeout(1500);
    r.eq(
      "header shows the generated emoji",
      (await page.locator(HEADER_ICON).innerText()).trim(),
      generated,
    );
    r.ok(
      "sidebar shows it too",
      (await glyphCount(page, generated)) >= 2,
      `glyphs showing ${generated}: ${await glyphCount(page, generated)}`,
    );

    // 3. A picked emoji survives later edits.
    await page.locator(HEADER_ICON).click();
    await page.getByPlaceholder("Search emoji…").fill("cactus");
    await page
      .locator("button[aria-pressed]")
      .filter({ hasText: PICKED })
      .first()
      .click();
    r.eq(
      "picked emoji stored",
      await waitForIcon(page, pageId, (i) => i === PICKED),
      PICKED,
    );
    await typeInBody(page, " Also: try rye flour next time.");
    await page.waitForTimeout(QUIET_MS);
    r.eq("pick not overwritten by a later edit", await iconOf(pageId), PICKED);

    // 4. Regenerate replaces it.
    await page.locator(HEADER_ICON).click();
    await page.getByText("Regenerate", { exact: true }).click();
    const pendingShown = await page
      .getByText("Regenerating…", { exact: true })
      .isVisible();
    r.note(`pending label visible right after click: ${pendingShown}`);
    const regenerated = await waitForIcon(page, pageId, (i) => i !== PICKED);
    r.ok(
      "Regenerate changed the icon",
      regenerated !== null && regenerated !== PICKED,
      `icon: ${regenerated}`,
    );
    r.note(`regenerated: ${regenerated}`);
    await page.keyboard.press("Escape");

    // 5. Remove sticks.
    await page.locator(HEADER_ICON).click();
    await page.getByText("Remove", { exact: true }).click();
    r.eq(
      "Remove cleared the icon",
      await waitForIcon(page, pageId, (i) => i === null),
      null,
    );
    await typeInBody(page, " And a longer bulk ferment in winter.");
    await page.waitForTimeout(QUIET_MS);
    r.eq("removed icon stays empty after an edit", await iconOf(pageId), null);

    r.ok(
      "no page errors",
      captured.pageErrors.length === 0,
      captured.pageErrors.join(" | "),
    );
  } finally {
    const res = await agentFetch(`/api/blocks/${pageId}`, { method: "DELETE" });
    r.ok("test page trashed", res.ok, `DELETE: HTTP ${res.status}`);
  }
});

await r.finish();
