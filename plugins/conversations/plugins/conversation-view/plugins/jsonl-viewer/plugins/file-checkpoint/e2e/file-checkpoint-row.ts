/**
 * Verifies Claude Code's rewind checkpoints (file-history-delta) render as a
 * one-line "Checkpoint <path>" row rather than the unknown-event raw-JSON card.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-checkpoint/e2e/file-checkpoint-row.ts --conv <id> [--out /tmp/file-checkpoint]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const convId = arg("conv") ?? "conv-1791993897-db4unm";
const out = arg("out") ?? "/tmp/file-checkpoint";
const ROW = '[data-event-key^="file-checkpoint:"]';

await withBrowser(async (h) => {
  const r = report("file checkpoints render as one line");
  const { page } = await h.session({ viewport: { width: 1280, height: 1000 } });

  await boot(page, pathUrl(`/agents/c/${convId}`), {
    marker: "[data-event-key]",
    settleMs: 2500,
  });

  r.ok(
    "no file-history-delta falls back to the unknown card",
    (await page
      .locator('[data-event-key^="unknown:"]')
      .filter({ hasText: "file-history-delta" })
      .count()) === 0,
    "an unknown row still carries a file-history-delta payload",
  );

  const rows = page.locator(ROW);
  const count = await rows.count();
  r.ok(
    "the transcript has a checkpoint row",
    count > 0,
    `no ${ROW} row — pick a conversation that edited files via --conv`,
  );
  if (count === 0) return r.finish();
  r.note(`${count} checkpoint row(s)`);

  const row = rows.first();
  r.ok(
    "the row names the checkpoint and its file",
    (await row.getByText("Checkpoint").count()) === 1 &&
      (await row.getByRole("button").first().textContent())?.includes("/") ===
        true,
    "missing the Checkpoint label or the file path",
  );
  // Centred: the section's sticky user-message header covers the top edge.
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await snap(page, out, "checkpoint");
  await r.finish();
});
