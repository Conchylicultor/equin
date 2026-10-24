// Screenshot a Singularity conversation with the edited-files pane open
// and one file selected in the right code pane.
//
// Usage:
//   ./equin run sidequests/ui-mastery/scripts/screenshot-conversation-with-file.mjs \
//     <conversation-url> <output-path>
//
// Example:
//   ./equin run sidequests/ui-mastery/scripts/screenshot-conversation-with-file.mjs \
//     http://singularity.localhost:9000/c/claude-1776191308 /tmp/out.png

import { chromium } from 'playwright';

const url = process.argv[2];
const out = process.argv[3];
if (!url || !out) {
  console.error('usage: <conversation-url> <output-path>');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

await page.locator('[aria-label="Edited files"]').first().click();
await page.waitForTimeout(1500);

const files = page.locator('button, [role="button"], li').filter({
  hasText: /\.(ts|tsx|md|json|go|css|sql|js)$/,
});
const n = await files.count();
for (let i = 0; i < n; i++) {
  const el = files.nth(i);
  const t = (await el.textContent())?.trim() || '';
  if (t.length < 200 && /\.(ts|tsx|md)$/.test(t)) {
    await el.click();
    break;
  }
}
await page.waitForTimeout(2000);
await page.screenshot({ path: out });
await browser.close();
