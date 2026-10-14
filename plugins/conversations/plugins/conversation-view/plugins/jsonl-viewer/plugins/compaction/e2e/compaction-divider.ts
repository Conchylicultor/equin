/**
 * Verifies a compacted conversation shows each compaction as one rule —
 * "Context compacted · …" — that unfolds into the summary, and that the
 * summary no longer renders as a message the user sent.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/compaction/e2e/compaction-divider.ts --conv <id> [--out /tmp/compaction]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const convId = arg("conv") ?? "conv-1791818418-k72458";
const out = arg("out") ?? "/tmp/compaction";
const ROW = '[data-event-key^="compaction:"]';

await withBrowser(async (h) => {
  const r = report("compaction renders as a divider");
  const { page } = await h.session({ viewport: { width: 1280, height: 1000 } });

  await boot(page, pathUrl(`/agents/c/${convId}`), {
    marker: "[data-event-key]",
    settleMs: 2500,
  });

  const rows = page.locator(ROW);
  const count = await rows.count();
  r.ok(
    "the transcript has a compaction row",
    count > 0,
    `no ${ROW} row — pick a compacted conversation via --conv`,
  );
  if (count === 0) return r.finish();
  r.note(`${count} compaction row(s)`);

  r.ok(
    "the compact summary is not a user message",
    (await page
      .locator('[data-event-key^="user-text:"]')
      .filter({ hasText: "This session is being continued" })
      .count()) === 0,
    "a user-text row still carries the compact summary preamble",
  );

  const row = rows.first();
  // Centred, not scrolled to the top edge: the section's sticky user-message
  // header is pinned there and would cover the rule.
  const centre = () =>
    row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await centre();
  await page.waitForTimeout(300);
  const trigger = row.getByRole("button", {
    name: /Context compacted|Compacted on request/,
  });
  r.ok(
    "the rule names the compaction",
    (await trigger.count()) === 1,
    "no trigger button in the row",
  );
  await snap(page, out, "folded");

  await trigger.click();
  await page.waitForTimeout(400);
  r.ok(
    "opening the rule shows the summary",
    (await row.locator("h1, h2, h3, li, p").count()) > 0,
    "the fold has no rendered markdown",
  );
  await centre();
  await page.waitForTimeout(300);
  await snap(page, out, "open");
  await r.finish();
});
